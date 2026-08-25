import { useState } from 'react'
import { inspectWorkspace } from '../api'
import { usePrivacy } from '../privacy'

export function LibraryInspect({ cwd }: { cwd: string }) {
  const privacy = usePrivacy()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!cwd) return null

  const run = async () => {
    setLoading(true)
    setError('')
    try {
      const snapshot = await inspectWorkspace(cwd)
      setText(snapshot.text)
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : 'Unable to inspect.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="library-inspect section-gap">
      <button type="button" className="text-button" onClick={() => void run()} disabled={loading}>
        {loading ? 'Inspecting…' : 'Inspect this workspace'}
      </button>
      {error && <p className="launch-form-status is-error" role="alert">{privacy.content(error)}</p>}
      {text && <pre>{privacy.content(text)}</pre>}
    </section>
  )
}
