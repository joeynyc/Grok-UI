import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeWatchError, watchTree } from './tree-watcher.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watcher did not emit in time')), ms)
    register((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

describe('watchTree', () => {
  it('reports nested changes with slash-separated relative paths and honors ignores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-tree-watch-'))
    cleanup.push(root)
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    const seen: string[] = []
    let notify: ((value: string) => void) | null = null
    const watcher = watchTree(root, {
      ignored: [/\/node_modules\//],
      onChange: (relative) => {
        seen.push(relative)
        notify?.(relative)
      },
    })
    // Give the native watcher a moment to arm before writing.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const first = waitFor<string>((resolve) => { notify = resolve })
    await fs.writeFile(path.join(root, 'src', 'deep', 'file.txt'), 'hello')
    expect(await first).toBe('src/deep/file.txt')

    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '// ignored')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen.some((item) => item.startsWith('node_modules/'))).toBe(false)
    watcher.close()
    watcher.close()
  })

  it('reports a missing root through onError instead of throwing', async () => {
    const error = await waitFor<unknown>((resolve) => {
      watchTree(path.join(os.tmpdir(), `grok-ui-missing-${Date.now()}`), {
        onChange: () => undefined,
        onError: resolve,
      })
    })
    expect(describeWatchError(error)).toBe('ENOENT')
  })

  it('describes descriptor exhaustion with a hint', () => {
    expect(describeWatchError(Object.assign(new Error('x'), { code: 'EMFILE' }))).toContain('too many open files')
    expect(describeWatchError(new Error('plain'))).toBe('plain')
  })
})

describe('watchTree without recursion', () => {
  it('only reports direct children', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-flat-watch-'))
    cleanup.push(root)
    await fs.mkdir(path.join(root, 'nested'))
    const seen: string[] = []
    let notify: ((value: string) => void) | null = null
    const watcher = watchTree(root, {
      recursive: false,
      onChange: (relative) => {
        seen.push(relative)
        notify?.(relative)
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    await fs.writeFile(path.join(root, 'nested', 'inner.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const top = waitFor<string>((resolve) => { notify = resolve })
    await fs.writeFile(path.join(root, 'active_sessions.json'), '[]')
    expect(await top).toBe('active_sessions.json')
    expect(seen.some((item) => item.includes('inner.txt'))).toBe(false)
    watcher.close()
  })
})
