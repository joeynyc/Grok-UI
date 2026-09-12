import { Bot, Box, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { usePrivacy } from '../privacy'
import { EmptyInline, PageIntro, Panel, SearchField } from '../shell/primitives'
import type { DashboardPayload } from '../types'
import { LibraryInspect } from './LibraryInspect'

export function LibraryView({
  data,
  query,
  onQuery,
}: {
  data: DashboardPayload
  query: string
  onQuery: (value: string) => void
}) {
  const privacy = usePrivacy()
  const filtered = data.library.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  const [selectedKey, setSelectedKey] = useState('')
  const groups = [
    { kind: 'skill' as const, label: 'Skills', icon: Sparkles, copy: 'Reusable instruction packages available to Grok.' },
    { kind: 'agent' as const, label: 'Agent profiles', icon: Bot, copy: 'Specialized operating roles for delegated work.' },
    { kind: 'plugin' as const, label: 'Marketplace manifests', icon: Box, copy: 'Plugin packages discovered in the local cache.' },
  ]
  const ordered = groups.flatMap((group) => filtered.filter((item) => item.kind === group.kind))
  const selected = ordered.find((item) => `${item.kind}:${item.source}:${item.name}` === selectedKey) || ordered[0] || null
  return (
    <>
      <PageIntro
        index="10"
        eyebrow="Capability library"
        title={<>What Grok can<br /><em>reach for.</em></>}
        description="Inspect a local skill, agent profile, or marketplace package. Bodies stay on disk."
      />
      <div className="view-toolbar">
        <SearchField value={query} onChange={onQuery} placeholder="Filter the capability index…" />
        <div className="toolbar-stat"><strong>{filtered.length}</strong><span>capabilities visible</span></div>
      </div>
      <section className="library-grid">
        {groups.map((group, groupIndex) => {
          const Icon = group.icon
          const items = filtered.filter((item) => item.kind === group.kind)
          return (
            <Panel key={group.kind} index={`04${String.fromCharCode(65 + groupIndex)}`} title={group.label} meta={`${items.length} found`}>
              <div className="library-intro"><Icon size={20} /><p>{group.copy}</p></div>
              <div className="capability-list">
                {items.length ? items.map((item) => {
                  const key = `${item.kind}:${item.source}:${item.name}`
                  return (
                    <button
                      type="button"
                      key={key}
                      className={selected && `${selected.kind}:${selected.source}:${selected.name}` === key ? 'is-selected' : ''}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="capability-icon">{item.kind === 'skill' ? 'S' : item.kind === 'agent' ? 'A' : 'P'}</span>
                      <strong>{privacy.capability(item.name, group.label.slice(0, -1))}</strong>
                      <span className={`source-tag source-${item.source}`}>{item.source}</span>
                    </button>
                  )
                }) : <EmptyInline>No matching {group.label.toLowerCase()}.</EmptyInline>}
              </div>
            </Panel>
          )
        })}
      </section>
      {selected && (
        <section className="inventory-detail section-gap" aria-live="polite">
          <small>Selected capability</small>
          <strong>{privacy.capability(selected.name, selected.kind)}</strong>
          <p>{selected.kind} from {selected.source} source. The file body is not loaded into the dashboard.</p>
        </section>
      )}
      <LibraryInspect cwd={data.sessions[0]?.cwd || ''} />
    </>
  )
}
