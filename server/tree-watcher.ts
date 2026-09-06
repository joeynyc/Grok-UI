import { statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

export interface TreeWatcherOptions {
  /** Patterns tested against the path relative to the watched root, wrapped in `/` separators. */
  ignored?: RegExp[]
  /** Watch nested directories too. Defaults to true. */
  recursive?: boolean
  onChange: (relativePath: string) => void
  /** Called at most once when the watcher fails; the watcher is closed before the call. */
  onError?: (error: unknown) => void
}

export interface TreeWatcher {
  close(): void
}

/**
 * Watch a directory tree with Node's native recursive `fs.watch`.
 *
 * On macOS this is one FSEvents stream and on Windows one ReadDirectoryChangesW
 * handle regardless of tree size, so a large repository or Grok home does not
 * consume one file descriptor per directory the way a per-directory watcher
 * does. Linux uses inotify watches, which are bounded by
 * `fs.inotify.max_user_watches` rather than the descriptor limit.
 */
export function watchTree(root: string, options: TreeWatcherOptions): TreeWatcher {
  const ignored = options.ignored || []
  let watcher: FSWatcher | null = null
  let failed = false
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    close()
    options.onError?.(error)
  }
  const close = () => {
    if (!watcher) return
    const current = watcher
    watcher = null
    try {
      current.close()
    } catch {
      // Closing twice or after an error is harmless.
    }
  }
  try {
    // Node reports a missing root differently per platform (a synchronous
    // throw, a later error event, or silence on Linux), so check up front.
    if (!statSync(root).isDirectory()) {
      throw Object.assign(new Error(`${root} is not a directory`), { code: 'ENOTDIR' })
    }
    watcher = watch(root, { recursive: options.recursive !== false, persistent: true }, (_event, filename) => {
      const relative = filename ? path.normalize(String(filename)).split(path.sep).join('/') : ''
      if (relative && ignored.some((pattern) => pattern.test(`/${relative}/`))) return
      options.onChange(relative)
    })
    watcher.on('error', fail)
  } catch (error) {
    queueMicrotask(() => fail(error))
  }
  return { close }
}

export function describeWatchError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code
    if (code === 'EMFILE' || code === 'ENFILE') return `${code} (too many open files; raise ulimit -n or reduce watched files)`
    if (code === 'ENOSPC') return `${code} (inotify watch limit reached; raise fs.inotify.max_user_watches)`
    return code
  }
  return error instanceof Error ? error.message : String(error)
}
