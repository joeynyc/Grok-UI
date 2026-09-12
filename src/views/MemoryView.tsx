import { Archive, BrainCircuit, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { formatBytes, timeAgo } from '../format'
import { usePrivacy } from '../privacy'
import { EmptyInline, PageIntro, Panel } from '../shell/primitives'
import type { DashboardPayload } from '../types'

export function MemoryView({ data }: { data: DashboardPayload }) {
  const privacy = usePrivacy()
  const scopes = ['global', 'workspace', 'session']
  const [selectedName, setSelectedName] = useState(data.memory[0]?.name || '')
  const selected = data.memory.find((item) => item.name === selectedName) || data.memory[0] || null
  return (
    <>
      <PageIntro
        index="11"
        eyebrow="Durable recall"
        title={<>Memory without<br /><em>the mystery.</em></>}
        description="Inspect which memory files Grok can see. File bodies stay on disk and are not rendered here."
      />
      <section className="memory-hero">
        <div className="memory-symbol"><BrainCircuit size={44} strokeWidth={1.2} /><span /></div>
        <div>
          <span className="kicker">Local memory index</span>
          <strong>{data.memory.length}</strong>
          <p>files across {new Set(data.memory.map((item) => item.scope)).size} scopes</p>
        </div>
        <div className="privacy-badge"><ShieldCheck size={18} /><span><strong>Metadata only</strong><small>Prompts and memory body text stay hidden.</small></span></div>
      </section>
      <section className="memory-columns section-gap">
        {scopes.map((scope, scopeIndex) => {
          const items = data.memory.filter((item) => item.scope === scope)
          return (
            <Panel key={scope} index={`05${String.fromCharCode(65 + scopeIndex)}`} title={`${scope[0].toUpperCase()}${scope.slice(1)} memory`} meta={`${items.length} files`}>
              <div className="memory-file-list">
                {items.length ? items.map((item) => (
                  <button
                    type="button"
                    key={item.name}
                    className={selected?.name === item.name ? 'is-selected' : ''}
                    onClick={() => setSelectedName(item.name)}
                  >
                    <Archive size={15} />
                    <span><strong>{privacy.memory(item.name)}</strong><small>{timeAgo(item.updatedAt)}</small></span>
                    <em>{formatBytes(item.bytes)}</em>
                  </button>
                )) : <EmptyInline>No {scope} memory files found.</EmptyInline>}
              </div>
            </Panel>
          )
        })}
      </section>
      {selected && (
        <section className="inventory-detail section-gap" aria-live="polite">
          <small>Selected memory file</small>
          <strong>{privacy.memory(selected.name)}</strong>
          <p>{selected.scope} scope · {formatBytes(selected.bytes)} · updated {timeAgo(selected.updatedAt)}. The Markdown body is not loaded into the dashboard.</p>
        </section>
      )}
    </>
  )
}
