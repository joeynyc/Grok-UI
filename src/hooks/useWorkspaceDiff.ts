import { useCallback, useEffect, useState } from 'react'
import { getWorkspaceDiff } from '../api'
import type { WorkspaceDiff } from '../types'

type RefreshVersion = string | number | null

interface DiffSelection {
  cwd: string
  file: string
}

interface DiffResult {
  selection: DiffSelection
  refreshVersion: RefreshVersion
  diff: WorkspaceDiff | null
  error: string
}

export function useWorkspaceDiff(cwd: string, refreshVersion: RefreshVersion = 0) {
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [result, setResult] = useState<DiffResult | null>(null)
  const currentSelection = selection?.cwd === cwd ? selection : null

  const openFile = useCallback((file: string) => {
    // A fresh selection also allows clicking the same file to reload its patch.
    setSelection(cwd && file ? { cwd, file } : null)
  }, [cwd])

  const reset = useCallback(() => {
    setSelection(null)
    setResult(null)
  }, [])

  useEffect(() => {
    setSelection((current) => current?.cwd === cwd ? current : null)
  }, [cwd])

  useEffect(() => {
    if (!currentSelection) return
    const controller = new AbortController()
    void getWorkspaceDiff(currentSelection.cwd, currentSelection.file, controller.signal)
      .then((diff) => {
        if (!controller.signal.aborted) {
          setResult({ selection: currentSelection, refreshVersion, diff, error: '' })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            selection: currentSelection,
            refreshVersion,
            diff: null,
            error: error instanceof Error ? error.message : 'Unable to load diff.',
          })
        }
      })
    return () => controller.abort()
  }, [currentSelection, refreshVersion])

  // Match during render, before effect cleanup, so a new heading can never
  // expose the previous selection's patch or error for even one frame.
  const currentResult = currentSelection
    && result?.selection === currentSelection
    && result.refreshVersion === refreshVersion
    ? result
    : null

  return {
    selectedFile: currentSelection?.file || '',
    openFile,
    diff: currentResult?.diff || null,
    loading: Boolean(currentSelection && !currentResult),
    error: currentResult?.error || '',
    reset,
  }
}
