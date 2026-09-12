import { Check, CircleAlert, Copy, RefreshCw, TimerReset } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buildRoster, shouldShowFirstRun } from '../live-roster'
import { PageIntro } from '../shell/primitives'
import type {
  ControlSnapshot,
  DashboardPayload,
  LiveSnapshot,
  RuntimeSnapshot,
  SessionRow,
  SetupCheckState,
  SetupStatus,
} from '../types'
import { LiveRoster } from './LiveRoster'
import { RuntimeIntelligencePanels } from './RuntimeIntelligencePanels'
import { SessionLaunchForm } from './SessionLaunchForm'

export function LiveView({
  live,
  runtime,
  data,
  control,
  setup,
  connected,
  onOpenSession,
  onRefresh,
  onRefreshControl,
}: {
  live: LiveSnapshot | null
  runtime: RuntimeSnapshot | null
  data: DashboardPayload
  control: ControlSnapshot | null
  setup: SetupStatus | null
  connected: boolean
  onOpenSession: (session: SessionRow | string) => void
  onRefresh: () => void
  onRefreshControl: () => Promise<void>
}) {
  const roster = useMemo(() => buildRoster(live, control), [control, live])
  const selected = roster[0]

  return (
    <>
      <PageIntro
        index="01"
        eyebrow="Live runtime"
        title={<>In the loop.<br /><em>Right now.</em></>}
        description="Watch every running Grok session as it works, waits, or needs you. Start one here, or keep using the CLI — both show up in this room."
      />
      <section className="live-summary-strip">
        <LiveSummaryMetric
          label="Open agents"
          value={String(roster.length)}
          detail={live?.activeCount ? `${live.activeCount} Grok process${live.activeCount === 1 ? '' : 'es'}` : 'live and managed sessions'}
          tone="lime"
        />
        <LiveSummaryMetric
          label="Working now"
          value={String(live?.workingCount || 0)}
          detail="active turns in flight"
          tone="paper"
        />
        <LiveSummaryMetric
          label="Needs input"
          value={String(live?.attentionCount || 0)}
          detail="permission or user prompt"
          tone={live?.attentionCount ? 'coral' : 'paper'}
        />
        <LiveSummaryMetric
          label="Updates"
          value={connected ? 'Live' : '—'}
          detail="local session changes"
          tone={connected ? 'lime' : 'coral'}
        />
      </section>

      {shouldShowFirstRun({
        setupReady: setup?.ready,
        hasRoster: Boolean(selected),
        archivedSessions: data.stats.sessions,
      }) ? (
        <FirstRunOnboarding
          connected={connected}
          setup={setup}
          data={data}
          live={live}
          control={control}
          onRefresh={onRefresh}
          onRefreshControl={onRefreshControl}
          onOpenSession={onOpenSession}
        />
      ) : !selected ? (
        <section className="no-live-agent section-gap">
          <div className="idle-radar" aria-hidden="true"><span /><span /><i /></div>
          <div className="kicker">Runtime clear</div>
          <h2>No active Grok sessions.</h2>
          <p>Start one here, or run Grok in any workspace. Either one appears here the moment it is live.</p>
          <SessionLaunchForm
            data={data}
            live={live}
            control={control}
            heading="Start a session"
            index="01"
            onRefresh={onRefreshControl}
            onLaunched={(session) => onOpenSession(session.id)}
          />
        </section>
      ) : (
        <LiveRoster
          live={live}
          control={control}
          sessions={data.sessions}
          onOpenSession={onOpenSession}
          onRefresh={onRefreshControl}
        />
      )}
      <RuntimeIntelligencePanels runtime={runtime} />
    </>
  )
}

function FirstRunOnboarding({
  connected,
  setup,
  data,
  live,
  control,
  onRefresh,
  onRefreshControl,
  onOpenSession,
}: {
  connected: boolean
  setup: SetupStatus | null
  data: DashboardPayload
  live: LiveSnapshot | null
  control: ControlSnapshot | null
  onRefresh: () => void
  onRefreshControl: () => Promise<void>
  onOpenSession: (session: SessionRow | string) => void
}) {
  const [copied, setCopied] = useState('')
  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(command)
      window.setTimeout(() => setCopied(''), 1_500)
    } catch {
      setCopied('')
    }
  }
  const cli = setup?.checks.find((check) => check.id === 'cli')
  const auth = setup?.checks.find((check) => check.id === 'auth')
  const state = setup?.checks.find((check) => check.id === 'state')
  const steps: Array<{
    index: string
    label: string
    copy: string
    command: string
    state: SetupCheckState | 'checking'
  }> = [
    {
      index: '01',
      label: 'Verify the CLI',
      copy: cli?.detail || 'Checking whether Grok Build is installed and executable…',
      command: 'grok version',
      state: cli?.state || 'checking',
    },
    {
      index: '02',
      label: 'Connect your account',
      copy: auth?.detail || 'Checking whether the CLI can access your Grok models…',
      command: 'grok login',
      state: auth?.state || 'checking',
    },
    {
      index: '03',
      label: 'Start the first session',
      copy: state?.state === 'ready'
        ? 'Start a session above, or run grok in any project. Either one registers here automatically.'
        : state?.detail || 'Start a session above, or open any project and run grok.',
      command: 'grok',
      state: 'action',
    },
  ]
  return (
    <section className="first-run section-gap">
      <div className="first-run-head">
        <div>
          <span className="kicker">
            {setup?.ready
              ? 'Ready to start'
              : setup ? 'Setup needed' : 'Checking setup'}
          </span>
          <h2>Zero to live<br /><em>in three moves.</em></h2>
        </div>
        <div className="first-run-status">
          <span className={cli?.state === 'ready' ? 'is-ready' : 'needs-action'}><i /> Grok CLI</span>
          <span className={auth?.state === 'ready' ? 'is-ready' : 'needs-action'}><i /> Account</span>
          <span><i /> First session</span>
        </div>
      </div>
      <div className="first-run-launch">
        <SessionLaunchForm
          data={data}
          live={live}
          control={control}
          heading="Start a session"
          index="01"
          onRefresh={onRefreshControl}
          onLaunched={(session) => onOpenSession(session.id)}
        />
      </div>
      <div className="first-run-steps">
        {steps.map((step) => (
          <article className={`setup-${step.state}`} key={step.index}>
            <span>{step.index}</span>
            <div>
              <small className={`setup-state setup-state-${step.state}`}>
                {step.state === 'ready'
                  ? <><Check size={11} /> Ready</>
                  : step.state === 'action'
                    ? <><CircleAlert size={11} /> Action needed</>
                    : <><TimerReset size={11} /> Checking</>}
              </small>
              <h3>{step.label}</h3>
              <p>{step.copy}</p>
            </div>
            <button type="button" onClick={() => void copy(step.command)}>
              <code>{step.command}</code>
              {copied === step.command ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </article>
        ))}
      </div>
      <footer>
        <span>
          {setup?.ready && connected
            ? <>Environment ready. Start a session here, or run <code>grok</code> in any project.</>
            : <>Need the full terminal report? Run <code>grok-ui doctor</code>.</>}
        </span>
        <button className="text-button" onClick={onRefresh}>
          Recheck setup <RefreshCw size={14} />
        </button>
      </footer>
    </section>
  )
}

function LiveSummaryMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'lime' | 'paper' | 'coral'
}) {
  return (
    <div className={`live-summary-metric live-tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}
