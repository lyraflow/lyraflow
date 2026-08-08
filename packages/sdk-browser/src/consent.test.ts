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

  it('never reads navigator at all when the gate is off', () => {
    // The above test pins the outcome but not the mechanism: since every nav
    // read already goes through a try/catch (below), a version that computes
    // the signal unconditionally and merely discards the result when
    // `!required` produces the exact same 'granted' outcome without ever
    // throwing — so a getter that THROWS cannot distinguish "never read" from
    // "read, then ignored". A call-count spy can: it fails the moment
    // anyone reads `navigator` unconditionally, which a throw-based
    // assertion here does not.
    const doNotTrack = vi.fn(() => '1')
    const nav = {} as Navigator
    Object.defineProperty(nav, 'doNotTrack', { get: doNotTrack })
    const gate = new ConsentGate({ required: false, nav })
    expect(gate.allowed()).toBe(true)
    expect(doNotTrack).not.toHaveBeenCalled()
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

  it('does not crash when the global navigator is explicitly undefined', () => {
    // This pins the "declared but undefined" shape only — `vi.stubGlobal`
    // defines a real `navigator` property set to `undefined`, so a bare
    // reference to it here never throws a ReferenceError the way it would
    // for a genuinely undeclared identifier. The `typeof navigator ===
    // 'undefined'` guard this exercises is the same code path an actually
    // undeclared global would hit — the ternary's two branches are identical
    // for "declared as undefined" and "never declared" — but the specific
    // failure mode a bare `navigator` reference would produce for an
    // undeclared identifier is NOT reproduced by this test. Neither of this
    // repo's two test environments can reproduce it either: happy-dom
    // declares `navigator`, and so does plain Node 22 by itself (it ships
    // its own global `Navigator`, see `node -e "console.log(navigator)"`) —
    // so there is no environment available here in which `navigator` is
    // genuinely undeclared. The
    // guard is kept as correct defensive code for embeds where it would be
    // (workers, older runtimes), on the strength of code inspection, not of
    // this test.
    vi.stubGlobal('navigator', undefined)
    try {
      expect(() => new ConsentGate({ required: true })).not.toThrow()
      expect(new ConsentGate({ required: true }).state()).toBe('pending')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
