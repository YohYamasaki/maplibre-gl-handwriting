// The spill target of a store in a browser (decisions 0023 and 0025): one IndexedDB database for the origin, a record per
// spilled stroke keyed by [store ID, stroke ID], and a Web Lock per store held while it is attached. A page that attaches
// a target deletes the records of the stores no page holds the lock of any more (e.g. a tab closed while it had spilled
// points), and the last layer of a store to be destroyed reads its points back and deletes its records
import { attachSpill, detachSpill, failSpill, spillStrokes, type SpillRecord, type SpillTarget } from './core/spill'
import type { StrokeStore } from './core/stroke'

/** The database of every store of the origin */
export const SPILL_DATABASE = 'maplibre-gl-handwriting-spill'
/** Its object store of records, keyed by [store, id] */
export const SPILL_RECORDS = 'points'
/** The name of a store's Web Lock is this followed by the store's ID */
export const SPILL_LOCK_PREFIX = `${SPILL_DATABASE}:`
/** How often the store writes the strokes nothing holds (core/spill.ts spillStrokes), in ms */
const SPILL_INTERVAL_MS = 1000

/** A record as the database keeps it */
export type StoredRecord = { store: string; id: string; points: Float64Array; pressure?: Float32Array }

/** Called with what failed, on the map of each layer that attached the target */
type Reporter = (error: Error) => void

/** A store's target and the layers that attached it */
type Attachment = {
  target: IndexedDBTarget
  reporters: Set<Reporter>
  timer: ReturnType<typeof setInterval> | null
  // The attach waits for the store's previous target to be let go of first
  starting: Promise<void> | null
  started: boolean
  // Set once the last layer let go: the detach under way
  leaving: Promise<void> | null
}

const attachments = new WeakMap<StrokeStore, Attachment>()

/**
 * Attaches the store's IndexedDB target for one more layer, the first time for the store, and returns the function that
 * lets go of it for that layer. Null, attaching nothing, when the browser has no IndexedDB or no Web Locks (e.g. a
 * page that is not a secure context) or the store was made with spill: false. `report` is told what fails
 */
export function attachIndexedDBSpill(store: StrokeStore, report: Reporter): (() => void) | null {
  if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) return null
  const current = attachments.get(store)
  if (current && !current.leaving) {
    current.reporters.add(report)
    return leaveOnce(store, current, report)
  }
  const attachment: Attachment = {
    target: new IndexedDBTarget(),
    reporters: new Set([report]),
    timer: null,
    starting: null,
    started: false,
    leaving: null,
  }
  const start = (): boolean => {
    const onError = (error: Error): void => {
      for (const reporter of attachment.reporters) reporter(error)
    }
    if (!attachSpill(store, { target: attachment.target, now: () => performance.now(), onError })) return false
    attachment.started = true
    attachment.timer = setInterval(() => void spillStrokes(store), SPILL_INTERVAL_MS)
    attachment.target.open().catch((error: unknown) => failSpill(store, asError(error)))
    return true
  }
  if (current?.leaving) {
    // The store spilled before, so it can: it is attached again once its last target has been let go of
    attachment.starting = current.leaving.then(() => {
      if (!attachment.leaving) start()
    })
  } else if (!start()) {
    return null
  }
  attachments.set(store, attachment)
  return leaveOnce(store, attachment, report)
}

/** The function that lets go of the target for one layer, once */
function leaveOnce(store: StrokeStore, attachment: Attachment, report: Reporter): () => void {
  let left = false
  return () => {
    if (left) return
    left = true
    attachment.reporters.delete(report)
    if (attachment.reporters.size > 0 || attachment.leaving) return
    // The last layer: the points come back into memory, the records go and the lock is let go of
    if (attachment.timer !== null) clearInterval(attachment.timer)
    attachment.timer = null
    attachment.leaving = (attachment.starting ?? Promise.resolve())
      .then(async () => {
        if (!attachment.started) return
        await detachSpill(store)
        attachment.target.close()
      })
      .finally(() => {
        if (attachments.get(store) === attachment) attachments.delete(store)
      })
  }
}

/** A store's records in the origin's database, under an ID of its own and the Web Lock of that ID */
class IndexedDBTarget implements SpillTarget {
  private readonly storeId = crypto.randomUUID()
  private opened: Promise<IDBDatabase> | null = null
  private releaseLock: (() => void) | null = null

  /** Takes the store's lock, opens the database and deletes the records of stores no page holds; once */
  open(): Promise<IDBDatabase> {
    this.opened ??= this.start()
    return this.opened
  }

  private async start(): Promise<IDBDatabase> {
    await new Promise<void>((resolve, reject) => {
      navigator.locks
        .request(SPILL_LOCK_PREFIX + this.storeId, () => {
          resolve()
          // Held until close
          return new Promise<void>((release) => (this.releaseLock = release))
        })
        .catch(reject)
    })
    const database = await openDatabase()
    await deleteAbandoned(database)
    return database
  }

  async put(records: SpillRecord[]): Promise<void> {
    const database = await this.open()
    await run(database, 'readwrite', 'write the points of strokes far from the view', (store) => {
      for (const { id, points, pressure } of records) {
        const record: StoredRecord = pressure
          ? { store: this.storeId, id, points, pressure }
          : { store: this.storeId, id, points }
        store.put(record)
      }
    })
  }

  async get(ids: string[]): Promise<Map<string, SpillRecord>> {
    const database = await this.open()
    const found = new Map<string, SpillRecord>()
    await run(database, 'readonly', 'read back the points of strokes', (store) => {
      for (const id of ids) {
        const request = store.get([this.storeId, id])
        request.onsuccess = () => {
          const record = request.result as StoredRecord | undefined
          if (!record) return
          found.set(
            id,
            record.pressure ? { id, points: record.points, pressure: record.pressure } : { id, points: record.points },
          )
        }
      }
    })
    return found
  }

  async delete(ids: string[]): Promise<void> {
    const database = await this.open()
    await run(database, 'readwrite', 'delete the points of strokes', (store) => {
      for (const id of ids) store.delete([this.storeId, id])
    })
  }

  async clear(): Promise<void> {
    const database = await this.open()
    await run(database, 'readwrite', 'delete the points of strokes', (store) => store.delete(recordsOf(this.storeId)))
  }

  /** Closes the database and lets go of the lock */
  close(): void {
    this.opened?.then((database) => database.close()).catch(() => {})
    this.releaseLock?.()
    this.releaseLock = null
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SPILL_DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(SPILL_RECORDS, { keyPath: ['store', 'id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(failure('open IndexedDB', request.error))
  })
}

/** Deletes the records of the stores whose lock no page holds (decision 0025) */
async function deleteAbandoned(database: IDBDatabase): Promise<void> {
  const stores: string[] = []
  await run(database, 'readonly', 'look for the records of closed pages', (store) => {
    const request = store.openKeyCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const [id] = cursor.key as [string, string]
      stores.push(id)
      // Past every record of that store: an array key sorts after every string
      cursor.continue([id, []])
    }
  })
  if (stores.length === 0) return
  const { held = [] } = await navigator.locks.query()
  const live = new Set(held.map((lock) => lock.name))
  const abandoned = stores.filter((id) => !live.has(SPILL_LOCK_PREFIX + id))
  if (abandoned.length === 0) return
  await run(database, 'readwrite', 'delete the records of closed pages', (store) => {
    for (const id of abandoned) store.delete(recordsOf(id))
  })
}

/** The key range of every record of a store */
function recordsOf(storeId: string): IDBKeyRange {
  return IDBKeyRange.bound([storeId], [storeId, []])
}

/** Runs `work` in a transaction on the records; resolves once it has committed */
function run(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  what: string,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(SPILL_RECORDS, mode)
      work(transaction.objectStore(SPILL_RECORDS))
    } catch (error) {
      reject(failure(what, error))
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(failure(what, transaction.error))
  })
}

/** An Error saying what could not be done, with the browser's error as its cause */
function failure(what: string, cause: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new Error(`maplibre-gl-handwriting could not ${what}${detail}`, { cause })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
