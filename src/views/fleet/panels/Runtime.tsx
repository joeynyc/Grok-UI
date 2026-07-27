import { Activity, AlertTriangle, Braces, RadioTower, Server } from 'lucide-react'
import { usePrivacy } from '../../../privacy'
import type { FleetHostView, RuntimeSnapshot } from '../../../types'
import { FleetPanelEmpty, SectionState } from '../SectionState'

export function FleetRuntime({ host }: { host: FleetHostView }) {
  const privacy = usePrivacy()
  const runtime: RuntimeSnapshot | null | undefined = host.snapshot?.runtime
  return (
    <SectionState host={host} section="runtime">
      {runtime ? (
        <div className="fleet-runtime">
          {runtime.error && <div className="fleet-runtime-warning"><AlertTriangle size={14} /> {privacy.content(runtime.error)}</div>}
          <section className="fleet-runtime-counts">
            <div><Braces size={15} /><span>Processes</span><strong>{runtime.processes.length}</strong></div>
            <div><RadioTower size={15} /><span>Ports</span><strong>{runtime.ports.length}</strong></div>
            <div><Server size={15} /><span>Services</span><strong>{runtime.services.length}</strong></div>
            <div><Activity size={15} /><span>Tests</span><strong>{runtime.tests.length}</strong></div>
          </section>
          <div className="fleet-runtime-grid">
            <section>
              <header><span>BOUNDED DESCENDANTS</span><small>{runtime.partial ? 'Partial' : runtime.available ? 'Available' : 'Unavailable'}</small></header>
              {runtime.processes.slice(0, 24).map((process) => (
                <div className="fleet-process-row" key={`${host.id}:${process.pid}`}>
                  <i className={`state-${process.state}`} />
                  <span><strong>{privacy.capability(process.name, 'Process')}</strong><small>{process.elapsed} · depth {process.depth}</small></span>
                  <em>{privacy.enabled ? 'PID ••••' : `PID ${process.pid}`}</em>
                </div>
              ))}
              {!runtime.processes.length && <p>No descendant processes reported.</p>}
            </section>
            <section>
              <header><span>SERVICES & SIGNALS</span><small>Metadata only</small></header>
              {runtime.services.slice(0, 12).map((service) => (
                <div className="fleet-service-row" key={`${host.id}:${service.id}`}>
                  <Server size={14} />
                  <span><strong>{privacy.capability(service.name, 'Service')}</strong><small>{service.kind} · {service.bind}</small></span>
                  <em>{privacy.enabled ? 'PORT ••••' : service.port ? `:${service.port}` : service.status}</em>
                </div>
              ))}
              {runtime.tests.slice(0, 8).map((test) => (
                <div className="fleet-service-row" key={`${host.id}:${test.id}`}>
                  <Activity size={14} />
                  <span><strong>{privacy.content(test.title)}</strong><small>{privacy.capability(test.framework, 'Framework')}</small></span>
                  <em>{test.status}</em>
                </div>
              ))}
              {!runtime.services.length && !runtime.tests.length && <p>No services or structured test signals reported.</p>}
            </section>
          </div>
          <p className="fleet-boundary-note">Remote runtime data is supplied by the bounded host agent. This browser does not connect to discovered ports or services.</p>
        </div>
      ) : (
        <FleetPanelEmpty
          icon={Braces}
          title="No runtime snapshot"
          copy="Runtime monitoring is advertised, but the host has not delivered a snapshot."
        />
      )}
    </SectionState>
  )
}
