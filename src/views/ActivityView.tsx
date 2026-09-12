import { CircleAlert, FileCode2, TimerReset, ToolCase, type LucideIcon } from 'lucide-react'
import { formatNumber } from '../format'
import { usePrivacy } from '../privacy'
import { EmptyInline, PageIntro, Panel } from '../shell/primitives'
import type { ActivityDay, DashboardPayload, RankedDatum } from '../types'

export function activityTotals(days: ActivityDay[]) {
  return days.reduce((acc, day) => ({
    turns: acc.turns + day.turns,
    tools: acc.tools + day.toolCalls,
    errors: acc.errors + day.errors,
    lines: acc.lines + day.linesChanged,
  }), { turns: 0, tools: 0, errors: 0, lines: 0 })
}

export function ActivityView({ data }: { data: DashboardPayload }) {
  const totals = activityTotals(data.activity)
  return (
    <>
      <PageIntro
        index="09"
        eyebrow="Operational telemetry"
        title={<>The shape of<br /><em>the work.</em></>}
        description="A two-week read on agent velocity, tool intensity, code movement, and friction."
      />
      <section className="signal-metrics">
        <SignalMetrics totals={totals} />
      </section>
      <Panel className="wide-activity section-gap" index="03A" title="Daily operating envelope" meta="Last 14 days">
        <ActivityMatrix days={data.activity} />
      </Panel>
      <section className="two-col-grid section-gap">
        <Panel index="03B" title="Tool distribution" meta="Session frequency">
          <RankedBars data={data.tools} empty="No tool activity has been recorded." />
        </Panel>
        <Panel index="03C" title="Model distribution" meta="Session frequency">
          <RankedBars data={data.models} empty="No model activity has been recorded." />
        </Panel>
      </section>
    </>
  )
}

/** The four telemetry tiles: turns, tool calls, lines moved, errors. */
export function SignalMetrics({ totals }: { totals: ReturnType<typeof activityTotals> }) {
  return (
    <>
      <SignalMetric label="Turns" value={formatNumber(totals.turns)} icon={TimerReset} />
      <SignalMetric label="Tool calls" value={formatNumber(totals.tools)} icon={ToolCase} />
      <SignalMetric label="Lines moved" value={formatNumber(totals.lines)} icon={FileCode2} />
      <SignalMetric label="Errors" value={formatNumber(totals.errors)} icon={CircleAlert} warning={totals.errors > 0} />
    </>
  )
}

function SignalMetric({ label, value, icon: Icon, warning = false }: { label: string; value: string; icon: LucideIcon; warning?: boolean }) {
  return (
    <div className={`signal-metric ${warning ? 'is-warning' : ''}`}>
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function ActivityMatrix({ days }: { days: ActivityDay[] }) {
  const metrics: Array<{ key: keyof Pick<ActivityDay, 'turns' | 'toolCalls' | 'linesChanged' | 'errors'>; label: string }> = [
    { key: 'turns', label: 'Turns' },
    { key: 'toolCalls', label: 'Tools' },
    { key: 'linesChanged', label: 'Code Δ' },
    { key: 'errors', label: 'Errors' },
  ]
  return (
    <div className="activity-matrix">
      <div className="matrix-dates">
        <span />
        {days.map((day) => <span key={day.date}>{day.label}<small>{day.date.slice(8)}</small></span>)}
      </div>
      {metrics.map((metric) => {
        const max = Math.max(1, ...days.map((day) => day[metric.key]))
        return (
          <div className="matrix-row" key={metric.key}>
            <strong>{metric.label}</strong>
            {days.map((day) => {
              const value = day[metric.key]
              const intensity = value / max
              return (
                <div
                  key={day.date}
                  className={`matrix-cell ${metric.key === 'errors' && value ? 'is-error' : ''}`}
                  style={{ '--intensity': intensity } as React.CSSProperties}
                  title={`${day.date} · ${metric.label}: ${value}`}
                >
                  <span>{value ? formatNumber(value) : '·'}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function RankedBars({ data, empty }: { data: RankedDatum[]; empty: string }) {
  const privacy = usePrivacy()
  const max = Math.max(1, ...data.map((item) => item.value))
  if (!data.length) return <EmptyInline>{empty}</EmptyInline>
  return (
    <div className="ranked-bars">
      {data.map((item, index) => (
        <div className="rank-row" key={item.name}>
          <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
          <div className="rank-main">
            <div className="rank-copy">
              <strong>{privacy.capability(item.name, 'Signal')}</strong>
              <span>{formatNumber(item.value)}</span>
            </div>
            <div className="rank-track"><span style={{ width: `${(item.value / max) * 100}%` }} /></div>
          </div>
        </div>
      ))}
    </div>
  )
}
