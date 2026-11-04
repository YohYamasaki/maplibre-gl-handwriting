// Headless Chrome over the DevTools protocol, and a server to load pages from, for the browser checks
// (e2e-example.mjs, e2e-dev.mjs). Taken from the app's e2e checks: every call has a timeout, the whole run has one,
// and the server and Chrome are stopped on every way out. Exit codes: 0 passed, 1 failed, 3 could not run here (no Chrome)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const SCREEN = { width: 1000, height: 700 }
/** A host name Chrome resolves to 127.0.0.1: http from it is not a secure context, as from the machine's IP address */
export const INSECURE_HOST = 'handwriting.test'
const SEND_TIMEOUT_MS = 30_000
const RUN_TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5000

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
export const line = (from, to, n = 20) =>
  Array.from({ length: n + 1 }, (_, i) => [
    from[0] + ((to[0] - from[0]) * i) / n,
    from[1] + ((to[1] - from[1]) * i) / n,
  ])
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
export const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 24)

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function waitFor(what, test, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await test().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(200)
  }
}

/** A port the OS reports free now; another process may still take it first, which --strictPort turns into a failed start */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const isGone = (child) => child.exitCode !== null || child.signalCode !== null

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function signal(child, sig) {
  try {
    if (child.group) process.kill(-child.pid, sig)
    else child.kill(sig)
  } catch {
    // Already exited
  }
}

/** Stops a child (and its process group, if it leads one) and waits until it has exited; SIGKILL after the grace period */
async function stop(child) {
  if (child.pid === undefined) return
  const done = () => isGone(child) && (!child.group || !groupAlive(child.pid))
  if (done()) return
  signal(child, 'SIGTERM')
  const killAt = Date.now() + KILL_GRACE_MS
  let killed = false
  while (!done() && Date.now() < killAt + KILL_GRACE_MS) {
    if (!killed && Date.now() >= killAt) {
      signal(child, 'SIGKILL')
      killed = true
    }
    await wait(50)
  }
}

function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    console.warn(`warning: could not remove ${dir}: ${e.message}`)
  }
}

function exitBefore(child, message) {
  return new Promise((_, reject) => {
    child.once('exit', () => reject(new Error(message)))
    child.once('error', (e) => reject(new Error(`${message}: ${e.message}`)))
  })
}

/**
 * Starts `command args` (a server listening on `port`, in its own process group) and headless Chrome, and returns the
 * run: check() for each named check, openClient() for a tab, and finish() to clean up and exit with the result
 */
export async function startRun(name, { command, args, cwd, port }) {
  if (!existsSync(CHROME)) {
    console.error(`${name}: Chrome not found at ${CHROME} (set CHROME_PATH). Skipped`)
    process.exit(3)
  }
  const profile = mkdtempSync(join(tmpdir(), 'handwriting-chrome-'))
  const children = []
  const failures = []
  const consoleErrors = []
  let browser
  let finishing

  const finish = (code, message) => {
    finishing ??= (async () => {
      clearTimeout(runTimer)
      if (message) (code === 0 ? console.log : console.error)(message)
      try {
        browser?.close()
      } catch {
        // Already closed
      }
      await Promise.all(children.map(stop))
      remove(profile)
      process.exit(code)
    })()
    return finishing
  }
  const runTimer = setTimeout(
    () => finish(1, `${name}: timed out after ${RUN_TIMEOUT_MS / 60_000} minutes`),
    RUN_TIMEOUT_MS,
  )
  process.on('SIGINT', () => finish(1, `${name}: interrupted (SIGINT)`))
  process.on('SIGTERM', () => finish(1, `${name}: terminated (SIGTERM)`))
  process.on('uncaughtException', (e) => finish(1, `${name}: ${e.stack ?? e.message}`))
  process.on('unhandledRejection', (e) => finish(1, `${name}: ${e?.stack ?? e}`))

  const server = spawn(command, args, { cwd, stdio: 'ignore', detached: true })
  server.group = true
  children.push(server)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      // A host name for this machine that is not localhost, so a page loaded from it is not a secure context (the
      // checks with insecure: true in example-checks.mjs); the servers listen on 127.0.0.1 too
      `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  children.push(chrome)

  try {
    await Promise.race([
      waitFor('the server', () => fetch(`http://localhost:${port}/`).then((r) => r.ok), 60000),
      exitBefore(server, `the server did not start (port ${port})`),
    ])
    const debuggerUrl = await Promise.race([
      waitFor('Chrome', async () => {
        const [chromePort, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')
        return chromePort && path ? `ws://127.0.0.1:${chromePort}${path}` : undefined
      }),
      exitBefore(chrome, 'Chrome exited before it was ready'),
    ])
    browser = new WebSocket(debuggerUrl)
    await new Promise((resolve, reject) => {
      browser.addEventListener('open', resolve, { once: true })
      browser.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true })
    })
  } catch (e) {
    await finish(1, `${name}: could not start: ${e.message}`)
  }

  let nextId = 1
  let closed = false
  const pending = new Map()
  browser.addEventListener('close', () => {
    closed = true
    for (const { reject } of pending.values()) reject(new Error('the connection to Chrome closed'))
    pending.clear()
  })
  browser.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg)
      pending.delete(msg.id)
    }
    if (msg.method === 'Runtime.exceptionThrown')
      consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('the connection to Chrome closed'))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} got no reply in ${SEND_TIMEOUT_MS / 1000}s`))
      }, SEND_TIMEOUT_MS)
      const settle = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      browser.send(JSON.stringify({ id, method, params, sessionId }))
    })

  /** A tab in its own browser context */
  async function openClient() {
    const {
      result: { browserContextId },
    } = await send('Target.createBrowserContext')
    const {
      result: { targetId },
    } = await send('Target.createTarget', { url: 'about:blank', browserContextId })
    const {
      result: { sessionId },
    } = await send('Target.attachToTarget', { targetId, flatten: true })
    const screenshot = async () => {
      await send('Page.bringToFront', {}, sessionId)
      await wait(300)
      return (await send('Page.captureScreenshot', { format: 'png' }, sessionId)).result.data
    }
    const client = {
      sessionId,
      send: (method, params = {}) => send(method, params, sessionId),
      async eval(expression) {
        const { result } = await send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
        if (result.exceptionDetails)
          throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
        return result.result.value
      },
      /** Opens a path of the server (starting with /), or any other URL as given */
      async navigate(path) {
        const url = path.startsWith('/') ? `http://localhost:${port}${path}` : path
        await send('Page.navigate', { url }, sessionId)
      },
      /** Drags through `points`; `whileDown`, if given, runs before the button is released */
      async drag(points, whileDown) {
        await send('Page.bringToFront', {}, sessionId)
        const mouse = (type, [x, y]) =>
          send(
            'Input.dispatchMouseEvent',
            { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 },
            sessionId,
          )
        await mouse('mousePressed', points[0])
        for (const p of points.slice(1)) {
          await mouse('mouseMoved', p)
          await wait(16)
        }
        if (whileDown) await whileDown()
        await mouse('mouseReleased', points.at(-1))
      },
      /** Selects a tool with its toolbar button: 'map', 'pen', 'highlighter', 'eraser', 'lasso' or 'laser' */
      tool(toolName) {
        const label = {
          map: 'Move map',
          pen: 'Pen',
          highlighter: 'Highlighter',
          eraser: 'Eraser',
          lasso: 'Lasso',
          laser: 'Laser',
        }[toolName]
        return client.eval(`(() => {
          const b = document.querySelector('.handwriting-toolbar button[aria-label="${label}"]')
          if (b.getAttribute('aria-pressed') !== 'true') b.click()
          return true
        })()`)
      },
      async key(key, code, keyCode, modifiers = 0) {
        const text = key.length === 1 && modifiers === 0 ? key : undefined
        await send(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text, modifiers },
          sessionId,
        )
        await send(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers },
          sessionId,
        )
      },
      /** The RGB of several screen pixels, read back from one screenshot inside the page */
      async pixels(points) {
        const data = await screenshot()
        return client.eval(`(async () => {
          const image = new Image(); image.src = 'data:image/png;base64,${data}'; await image.decode()
          const canvas = new OffscreenCanvas(image.width, image.height); const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0)
          return ${JSON.stringify(points)}.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)])
        })()`)
      },
    }
    await send('Runtime.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { ...SCREEN, deviceScaleFactor: 1, mobile: false }, sessionId)
    return client
  }

  async function check(checkName, run) {
    try {
      await run()
      console.log(`  ok   ${checkName}`)
    } catch (e) {
      failures.push(checkName)
      console.log(`  FAIL ${checkName}: ${e.message}`)
    }
  }

  /** Ends the run: failed when a check failed or the page logged an error */
  function done() {
    if (consoleErrors.length > 0) {
      failures.push('console errors')
      console.log(`  FAIL errors in the page:\n${consoleErrors.map((e) => `    ${e}`).join('\n')}`)
    }
    return failures.length > 0 ? finish(1, `${name}: ${failures.length} failed`) : finish(0, `${name}: all passed`)
  }

  return { openClient, check, done, finish }
}
