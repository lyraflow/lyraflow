import { describe, expect, it } from 'vitest'
import { SERVER_SIDE_LIBRARIES, isServerSideLibrary } from './libraries.js'

describe('isServerSideLibrary', () => {
  it('recognises each SDK on the allowlist', () => {
    for (const name of SERVER_SIDE_LIBRARIES) {
      expect(isServerSideLibrary(name)).toBe(true)
    }
    expect(SERVER_SIDE_LIBRARIES.length).toBeGreaterThan(0)
  })

  // An ALLOWLIST, not a `lyraflow-` prefix rule. A prefix rule would grant
  // exemption to any name someone invents, including a forged one that
  // happens to look plausible -- and, worse, to `lyraflow-browser`, which
  // would let a crawler executing JS on an instrumented page sail through.
  it('does not recognise an unknown lyraflow-prefixed name', () => {
    expect(isServerSideLibrary('lyraflow-rust')).toBe(false)
  })

  // Not a special case in the implementation -- simply absent from the list,
  // like any unrecognised name. Named here because it is the one most likely
  // to be added by mistake.
  it('does not recognise the browser library', () => {
    expect(isServerSideLibrary('lyraflow-browser')).toBe(false)
  })

  it('does not recognise an absent or empty name', () => {
    expect(isServerSideLibrary(undefined)).toBe(false)
    expect(isServerSideLibrary('')).toBe(false)
  })

  // Case-sensitive on purpose: these are names Lyraflow's own SDKs send as
  // literals, not user input to be normalised. Accepting variants would make
  // the allowlist a fuzzy match by degrees.
  it('is case-sensitive', () => {
    expect(isServerSideLibrary('Lyraflow-Node')).toBe(false)
  })
})
