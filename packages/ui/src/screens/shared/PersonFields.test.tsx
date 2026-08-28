import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AttributesSection,
  TraitsSection,
  contextFields,
  labelFor,
  traitFields,
} from './PersonFields.js'

describe('labelFor', () => {
  it('labels a utm field as UTM and marks the first-touch ones', () => {
    expect(labelFor('utm_source')).toBe('UTM source (first touch)')
    expect(labelFor('device_type')).toBe('Device type')
    expect(labelFor('country')).toBe('Country')
  })
})

describe('contextFields', () => {
  it('reads context off a LyraEvent as readily as off a MemberRow', () => {
    // The whole reason the parameter was widened: the profile's context panel
    // reads the newest event, not a member row.
    const fields = contextFields({ country: 'TR', os: 'Linux', browser: '' })
    expect(fields.find((f) => f.label === 'Country')?.value).toBe('TR')
  })
})

describe('traitFields', () => {
  it('merges the two trait maps and sorts by key', () => {
    const fields = traitFields({ traits: { plan: 'pro' }, traits_num: { credits: 0, seats: 12 } })
    expect(fields.map((f) => f.label)).toEqual(['credits', 'plan', 'seats'])
    expect(fields.find((f) => f.label === 'credits')?.value).toBe('0')
  })

  it('renders a numeric trait raw, never localised', () => {
    // A trait that is an id or a year must not read back as "2,026" in a panel
    // whose job is to show what was received.
    const fields = traitFields({ traits_num: { signup_year: 2026 } })
    expect(fields).toHaveLength(1)
    expect(fields[0]?.value).toBe('2026')
  })
})

describe('TraitsSection', () => {
  it('says traits were withheld rather than that there are none', () => {
    render(<TraitsSection traits={{}} traits_num={{}} trait_total={0} withheld />)
    expect(screen.getByText(/cannot be split/i)).toBeInTheDocument()
    expect(screen.queryByText(/No traits recorded/i)).not.toBeInTheDocument()
  })
})

describe('TraitsSection withheld + trait_total', () => {
  it('does not also claim traits are held back when they are withheld', () => {
    // A nonzero trait_total alongside withheld would otherwise render two
    // contradictory statements: "not shown for a deletion request" AND
    // "N more traits are recorded and not shown here". The server keeps
    // trait_total at 0 under a deletion boundary today, but this component
    // must not depend on that upstream invariant to avoid contradicting itself.
    render(<TraitsSection traits={{}} traits_num={{}} trait_total={12} withheld />)
    expect(screen.getByText(/cannot be split/i)).toBeInTheDocument()
    expect(screen.queryByText(/more traits are recorded/i)).not.toBeInTheDocument()
  })
})

describe('AttributesSection', () => {
  it('counts attributes with no value rather than listing them blank', () => {
    render(<AttributesSection source={{ country: 'TR', os: '', browser: '' }} />)
    // The brief's literal regex (`/2 attributes have no value/i`) does not match the
    // verbatim-preserved copy, which reads "2 MORE attributes have no value" -- see
    // `MemberList.test.tsx`'s own `/3 more attributes have no value recorded/`. Matching
    // the real copy here rather than editing the copy to fit the brief's regex.
    expect(screen.getByText(/2 more attributes have no value/i)).toBeInTheDocument()
  })
})
