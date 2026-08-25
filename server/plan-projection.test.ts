import { describe, expect, it } from 'vitest'
import { applyPlanUpdate, todosFromPlan } from './plan-projection.js'

describe('plan projection', () => {
  it('turns ACP plan entries into a reviewable plan and todos', () => {
    const plan = applyPlanUpdate(null, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect workspace', priority: 'high', status: 'pending' },
        { content: 'Write the change', priority: 'medium', status: 'pending' },
      ],
    })
    expect(plan.status).toBe('review')
    expect(plan.entries).toHaveLength(2)
    expect(todosFromPlan(plan).map((item) => item.status)).toEqual(['pending', 'pending'])
  })

  it('marks in-progress plans as planning and completed plans as approved', () => {
    const planning = applyPlanUpdate(null, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Doing', priority: 'high', status: 'in_progress' }],
    })
    expect(planning.status).toBe('planning')
    const done = applyPlanUpdate(planning, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Doing', priority: 'high', status: 'completed' }],
    })
    expect(done.status).toBe('approved')
  })
})
