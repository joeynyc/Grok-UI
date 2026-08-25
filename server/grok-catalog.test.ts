import { describe, expect, it } from 'vitest'
import { parseModelList } from './grok-catalog.js'

describe('model catalog', () => {
  it('parses grok models output into unique ids', () => {
    expect(parseModelList('Available models\n* grok-4.6\ngrok-e2e extra label\ngrok-4.6\n')).toEqual([
      { id: 'grok-4.6', label: 'grok-4.6' },
      { id: 'grok-e2e', label: 'grok-e2e extra label' },
    ])
  })
})
