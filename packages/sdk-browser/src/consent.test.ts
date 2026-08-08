/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { ConsentGate, MAX_HELD_EVENTS } from './consent.js'
import type { QueuedEvent } from './payload.js'

const event = (id: string): QueuedEvent => ({
  type: 'track',
  message_id: id,
  timestamp: new Date().toISOString(),
  anonymous_id: 'anon-1',
  context: {},
  event: 'x',
})

describe('ConsentGate', () => {
  it('allows everything when the gate is off', () => {
    const gate = new ConsentGate({ required: false })
    expect(gate.allowed()).toBe(true)
    expect(gate.state()).toBe('granted')
  })

  it('forbids everything until granted when the gate is on', () => {
    const gate = new ConsentGate({ required: true })
    expect(gate.allowed()).toBe(false)
    expect(gate.state()).toBe('pending')
  })

  it('releases held events on grant, in order', () => {
    const gate = new ConsentGate({ required: true })
    gate.hold(event('m1'))
    gate.hold(event('m2'))
    expect(gate.decide(true).map((e) => e.message_id)).toEqual(['m1', 'm2'])
    expect(gate.allowed()).toBe(true)
  })

  it('drops held events on refusal and stays closed', () => {
    const gate = new ConsentGate({ required: true })
    gate.hold(event('m1'))
    expect(gate.decide(false)).toEqual([])
    expect(gate.allowed()).toBe(false)
    expect(gate.state()).toBe('refused')
  })

  it('bounds what it holds, dropping oldest first', () => {
    // A page where consent is never granted must not grow without bound
    // either — the same rule the persisted queue follows.
    const gate = new ConsentGate({ required: true })
    for (let i = 0; i < MAX_HELD_EVENTS + 5; i += 1) gate.hold(event(`m${i}`))
    const released = gate.decide(true)
    expect(released).toHaveLength(MAX_HELD_EVENTS)
    expect(released[0]?.message_id).toBe('m5')
  })

  it('treats Do Not Track as refusal when the gate is on', () => {
    const gate = new ConsentGate({ required: true, nav: { doNotTrack: '1' } as Navigator })
    expect(gate.state()).toBe('refused')
    expect(gate.allowed()).toBe(false)
  })

  it('treats Global Privacy Control as refusal when the gate is on', () => {
    const nav = { globalPrivacyControl: true } as unknown as Navigator
    expect(new ConsentGate({ required: true, nav }).state()).toBe('refused')
  })

  it('ignores Do Not Track when the gate is off', () => {
    // With the gate off the integrator has taken that decision themselves; us
    // overriding it would be us deciding their compliance posture for them.
    const gate = new ConsentGate({ required: false, nav: { doNotTrack: '1' } as Navigator })
    expect(gate.allowed()).toBe(true)
  })

  // Beyond the brief: `navigator` is host-controlled, and `doNotTrack` in
  // particular has never had one shape. Nothing below may throw.

  it('treats the old IE encoding ("yes") as Do Not Track', () => {
    const gate = new ConsentGate({ required: true, nav: { doNotTrack: 'yes' } as Navigator })
    expect(gate.state()).toBe('refused')
  })

  it('treats the old Chrome encoding (numeric 1) as Do Not Track', () => {
    const nav = { doNotTrack: 1 } as unknown as Navigator
    expect(new ConsentGate({ required: true, nav }).state()).toBe('refused')
  })

  it('does not treat an unset Do Not Track ("unspecified"/null/absent) as a signal', () => {
    expect(
      new ConsentGate({ required: true, nav: { doNotTrack: 'unspecified' } as Navigator }).state(),
    ).toBe('pending')
    expect(
      new ConsentGate({
        required: true,
        nav: { doNotTrack: null } as unknown as Navigator,
      }).state(),
    ).toBe('pending')
    expect(new ConsentGate({ required: true, nav: {} as Navigator }).state()).toBe('pending')
  })

  it('does not crash and does not refuse when doNotTrack is a throwing getter', () => {
    const nav = {} as Navigator
    Object.defineProperty(nav, 'doNotTrack', {
      get() {
        throw new Error('hostile getter')
      },
    })
    expect(() => new ConsentGate({ required: true, nav })).not.toThrow()
    expect(new ConsentGate({ required: true, nav }).state()).toBe('pending')
  })

  it('does not crash and does not refuse when globalPrivacyControl is a throwing getter', () => {
    const nav = {} as Navigator
    Object.defineProperty(nav, 'globalPrivacyControl', {
      get() {
        throw new Error('hostile getter')
      },
    })
    expect(() => new ConsentGate({ required: true, nav })).not.toThrow()
    expect(new ConsentGate({ required: true, nav }).state()).toBe('pending')
  })

  it('does not crash when navigator itself is undefined (non-browser context)', () => {
    vi.stubGlobal('navigator', undefined)
    try {
      expect(() => new ConsentGate({ required: true })).not.toThrow()
      expect(new ConsentGate({ required: true }).state()).toBe('pending')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
