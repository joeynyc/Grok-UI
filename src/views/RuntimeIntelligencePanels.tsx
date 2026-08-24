import {
  Activity,
  Braces,
  CircleAlert,
  Database,
  FlaskConical,
  Network,
  RadioTower,
  Server,
} from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { usePrivacy } from '../privacy'
import type {
  ExternalToolCall,
  RuntimeProcess,
  RuntimeService,
  RuntimeSnapshot,
  RuntimeTestRun,
} from '../types'

const MAX_VISIBLE_PROCESSES = 40
const MAX_VISIBLE_SERVICES = 20
const MAX_VISIBLE_SIGNALS = 12

export function RuntimeIntelligencePanels({ runtime }: { runtime: RuntimeSnapshot | null }) {
  const privacy = usePrivacy()
  if (!runtime) {
    return (
      <section className="runtime-intelligence section-gap">
        <header className="runtime-intelligence-head">
          <div><span>01B / RUNTIME INTELLIGENCE</span><h2>Inspecting local descendants.</h2></div>
          <small><i /> Establishing bounded process view</small>
        </header>
      </section>
    )
  }

  const databaseCount = runtime.services.filter((service) => service.kind === 'database').length
  return (
    <section className="runtime-intelligence section-gap">
      <header className="runtime-intelligence-head">
        <div>
          <span>01B / RUNTIME INTELLIGENCE</span>
          <h2>What the agents started.</h2>
          <p>Bounded descendants, listening ports, local services, tests, and structured external calls.</p>
        </div>
        <small className={runtime.partial ? 'is-partial' : runtime.available ? 'is-live' : 'is-unavailable'}>
          <i /> {runtime.partial ? 'Partial inspection' : runtime.available ? 'Local inspection live' : 'Inspection unavailable'}
        </small>
      </header>

      {runtime.error && (
        <div className="runtime-intelligence-warning">
          <CircleAlert size={15} />
          <span>{runtime.error}</span>
        </div>
      )}

      <div className="runtime-intelligence-summary">
        <RuntimeCounter icon={<Braces size={17} />} label="Processes" value={runtime.processes.length} />
        <RuntimeCounter icon={<RadioTower size={17} />} label="Open ports" value={runtime.ports.length} />
        <RuntimeCounter icon={<Database size={17} />} label="Databases" value={databaseCount} />
        <RuntimeCounter icon={<Server size={17} />} label="Services" value={runtime.services.length} />
        <RuntimeCounter icon={<FlaskConical size={17} />} label="Tests" value={runtime.tests.length} />
        <RuntimeCounter icon={<Network size={17} />} label="External calls" value={runtime.externalCalls.length} />
      </div>

      <div className="runtime-intelligence-grid">
        <RuntimePanel
          eyebrow="Process tree"
          title="Spawned descendants"
          meta={`${runtime.roots.length} root${runtime.roots.length === 1 ? '' : 's'} · depth capped at 8`}
        >
          {runtime.processes.length ? (
            <div className="runtime-process-list">
              {runtime.processes.slice(0, MAX_VISIBLE_PROCESSES).map((process) => (
                <ProcessRow key={process.pid} process={process} privacyEnabled={privacy.enabled} />
              ))}
              {runtime.processes.length > MAX_VISIBLE_PROCESSES && (
                <div className="runtime-list-more">
                  +{runtime.processes.length - MAX_VISIBLE_PROCESSES} bounded descendants
                </div>
              )}
            </div>
          ) : (
            <RuntimeEmpty>No registered process roots are available right now.</RuntimeEmpty>
          )}
        </RuntimePanel>

        <RuntimePanel
          eyebrow="Discovery"
          title="Ports and local services"
          meta="No active network probes"
        >
          {runtime.services.length ? (
            <div className="runtime-service-list">
              {runtime.services.slice(0, MAX_VISIBLE_SERVICES).map((service) => (
                <ServiceRow key={service.id} service={service} privacyEnabled={privacy.enabled} />
              ))}
              {runtime.services.length > MAX_VISIBLE_SERVICES && (
                <div className="runtime-list-more">
                  +{runtime.services.length - MAX_VISIBLE_SERVICES} local services
                </div>
              )}
            </div>
          ) : (
            <RuntimeEmpty>No listening services were found inside the bounded process trees.</RuntimeEmpty>
          )}
        </RuntimePanel>

        <RuntimePanel eyebrow="Verification" title="Test command status" meta="Structured tool lifecycle">
          {runtime.tests.length ? (
            <div className="runtime-signal-list">
              {runtime.tests.slice(0, MAX_VISIBLE_SIGNALS).map((test) => (
                <TestRow key={test.id} test={test} />
              ))}
            </div>
          ) : (
            <RuntimeEmpty>Test commands will appear when Grok reports their tool lifecycle.</RuntimeEmpty>
          )}
        </RuntimePanel>

        <RuntimePanel eyebrow="Boundaries" title="External tool calls" meta="Titles and status only">
          {runtime.externalCalls.length ? (
            <div className="runtime-signal-list">
              {runtime.externalCalls.slice(0, MAX_VISIBLE_SIGNALS).map((call) => (
                <ExternalRow key={call.id} call={call} />
              ))}
            </div>
          ) : (
            <RuntimeEmpty>No structured external calls are visible in the recent feed.</RuntimeEmpty>
          )}
        </RuntimePanel>
      </div>
      <footer className="runtime-intelligence-foot">
        <span>LOCAL ONLY</span>
        <p>
          Process inspection is capped at 160 descendants and never exposes command arguments.
          Port discovery is limited to those PIDs; Grok UI does not connect to discovered services.
        </p>
      </footer>
    </section>
  )
}

function RuntimeCounter({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return <div className="runtime-counter">{icon}<span>{label}</span><strong>{value.toLocaleString()}</strong></div>
}

function RuntimePanel({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow: string
  title: string
  meta: string
  children: ReactNode
}) {
  return (
    <article className="runtime-intelligence-panel">
      <header>
        <div><span>{eyebrow}</span><h3>{title}</h3></div>
        <small>{meta}</small>
      </header>
      {children}
    </article>
  )
}

function ProcessRow({ process, privacyEnabled }: { process: RuntimeProcess; privacyEnabled: boolean }) {
  const privacy = usePrivacy()
  const style = { '--process-depth': Math.min(process.depth, 8) } as CSSProperties
  return (
    <div className="runtime-process-row" style={style}>
      <span className="runtime-tree-rail"><i /></span>
      <span className={`runtime-process-state state-${process.state}`} />
      <span>
        <strong>{privacyEnabled ? privacy.capability(process.name, 'Process') : process.name}</strong>
        <small>{process.depth ? `child depth ${process.depth}` : 'session root'} · {process.elapsed}</small>
      </span>
      <span>{privacyEnabled ? 'PID ••••' : `PID ${process.pid}`}</span>
      <em>{process.ports.length ? privacyEnabled ? 'PORT ••••' : process.ports.join(', ') : '—'}</em>
    </div>
  )
}

function ServiceRow({ service, privacyEnabled }: { service: RuntimeService; privacyEnabled: boolean }) {
  const privacy = usePrivacy()
  return (
    <div className="runtime-service-row">
      <span className={`runtime-service-icon service-${service.kind}`}>
        {service.kind === 'database' || service.kind === 'cache'
          ? <Database size={15} />
          : <Server size={15} />}
      </span>
      <span>
        <strong>{privacyEnabled ? privacy.capability(service.name, 'Service') : service.name}</strong>
        <small>{service.kind.replaceAll('-', ' ')} · {service.bind} bind</small>
      </span>
      <span>{service.port ? privacyEnabled ? 'PORT ••••' : `:${service.port}` : service.status}</span>
    </div>
  )
}

function TestRow({ test }: { test: RuntimeTestRun }) {
  const privacy = usePrivacy()
  return (
    <div className="runtime-signal-row">
      <span className={`runtime-test-status test-${test.status}`}><i /></span>
      <span>
        <strong>{privacy.content(test.title)}</strong>
        <small>{test.framework} · {test.incomplete ? 'incomplete outcome' : 'structured status'}</small>
      </span>
      <em>{test.status}</em>
    </div>
  )
}

function ExternalRow({ call }: { call: ExternalToolCall }) {
  const privacy = usePrivacy()
  return (
    <div className="runtime-signal-row">
      <span className={`runtime-external-kind external-${call.category}`}><Activity size={14} /></span>
      <span>
        <strong>{privacy.content(call.title)}</strong>
        <small>{call.category} · safe title only</small>
      </span>
      <em>{call.status || 'unknown'}</em>
    </div>
  )
}

function RuntimeEmpty({ children }: { children: ReactNode }) {
  return <div className="runtime-intelligence-empty">{children}</div>
}
