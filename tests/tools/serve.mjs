// A static file server for the browser checks of built examples (e2e-bundlers.mjs): `node serve.mjs <dir> <port>`.
// A directory serves its index.html. .wasm goes as application/wasm, which WebAssembly.instantiateStreaming needs, and
// .js and .mjs as text/javascript, which module scripts and module workers need. Nothing outside <dir> is served.
// It listens on 127.0.0.1, for http://localhost:<port> and for http://handwriting.test:<port> (browser.mjs)
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const [dir, port] = process.argv.slice(2)
if (!dir || !port) {
  console.error('usage: node serve.mjs <dir> <port>')
  process.exit(2)
}
const root = resolve(dir)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** The file a request path names, or null when there is none or it is outside the root */
function fileOf(pathname) {
  let file = resolve(join(root, pathname))
  if (file !== root && !file.startsWith(root + sep)) return null
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html')
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

createServer((request, response) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    response.writeHead(400).end()
    return
  }
  const file = request.method === 'GET' || request.method === 'HEAD' ? fileOf(pathname) : null
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(file).pipe(response)
  // 127.0.0.1, where Chrome sends browser.mjs's INSECURE_HOST: 'localhost' may resolve to ::1 only
}).listen(Number(port), '127.0.0.1')
