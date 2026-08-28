import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Person } from '../../api/types.js'
import { IdentityHeader } from './IdentityHeader.js'

const PERSON: Person = {
  person_id: 'u1',
  ids: ['u1', 'u2', 'dev-a'],
  devices: ['dev-a'],
  first_seen: '2026-06-01T09:00:00.000Z',
  last_seen: '2026-08-20T15:30:00.000Z',
  events: 128,
  traits: {},
  traits_num: {},
  trait_total: 0,
  traits_withheld: false,
}

describe('IdentityHeader', () => {
  it('renders the person id as the heading', () => {
    render(<IdentityHeader person={PERSON} />)
    expect(screen.getByRole('heading', { name: 'u1' })).toBeInTheDocument()
  })

  it('splits ids into user/anonymous ids and devices, not merely lists them all in one place', () => {
    // The split, not just presence: a test asserting `dev-a` appears
    // ANYWHERE in the container would pass even if every id landed in the
    // wrong column. This pins each id to its own column specifically.
    render(<IdentityHeader person={PERSON} />)
    const userIds = screen.getByTestId('identity-user-ids')
    const devices = screen.getByTestId('identity-devices')
    expect(within(userIds).getByText('u2')).toBeInTheDocument()
    expect(within(userIds).queryByText('dev-a')).toBeNull()
    expect(within(devices).getByText('dev-a')).toBeInTheDocument()
    expect(within(devices).queryByText('u2')).toBeNull()
    // The wrapping container still carries every id, for a caller that only
    // wants to know an id was shown at all rather than which column.
    expect(screen.getByTestId('identity-ids')).toHaveTextContent('dev-a')
    expect(screen.getByTestId('identity-ids')).toHaveTextContent('u2')
  })

  it('says there are no devices rather than rendering an empty list', () => {
    render(<IdentityHeader person={{ ...PERSON, ids: ['u1'], devices: [] }} />)
    expect(screen.getByText(/no devices recorded/i)).toBeInTheDocument()
    expect(screen.queryByTestId('identity-devices')).toBeNull()
  })

  it('shows the event count and both dates', () => {
    // `toLocaleDateString(undefined, ...)` under this environment's default
    // locale (en-US, matching `MemberList.tsx`'s own `formatDate`, which
    // this mirrors) renders "Jun 1, 2026", not day-month-year.
    render(<IdentityHeader person={PERSON} />)
    const summary = screen.getByText(/128/)
    expect(summary).toHaveTextContent('Jun 1, 2026')
    expect(summary).toHaveTextContent('Aug 20, 2026')
  })
})
