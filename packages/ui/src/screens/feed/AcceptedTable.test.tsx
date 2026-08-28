import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { LyraEvent } from '../../api/types.js'
import { AcceptedTable } from './AcceptedTable.js'

/** `linkPeople`'s `<Link>` needs a router context; every other test in this
 * file renders without one, since a plain string cell needs none. */
function Router(props: { children: ReactNode }) {
  return <MemoryRouter>{props.children}</MemoryRouter>
}

/** The context fields an event that carried none of them still arrives
 * with -- ClickHouse has no null here, so they are empty strings on the
 * wire rather than absent. */
const EMPTY_CONTEXT = {
  url: '',
  referrer: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_term: '',
  utm_content: '',
  device_type: '',
  os: '',
  browser: '',
  country: '',
  region: '',
  city: '',
}

function event(over: Partial<LyraEvent> = {}): LyraEvent {
  return {
    ...EMPTY_CONTEXT,
    event_id: 'e1',
    timestamp: '2026-08-15T09:14:02.000Z',
    event_name: 'page_view',
    anonymous_id: 'anon_8fa2',
    user_id: '',
    properties: {},
    properties_num: {},
    path: '/pricing',
    ...over,
  }
}

/** The summary row's own Event cell -- clicked to toggle the row. Queried
 * as a cell, not by text: once the panel is open the event's name appears
 * inside it too, as the first attribute it lists. */
function eventCell(name: string) {
  return screen.getByRole('cell', { name })
}

/** The row whose chevron currently reads expanded, by its event's name. */
function toggleFor(name: string | RegExp) {
  return screen.getByRole('button', { name: new RegExp(`details for ${name}`, 'i') })
}

describe('AcceptedTable row detail', () => {
  it('shows no detail until a row is clicked', () => {
    render(<AcceptedTable events={[event({ properties: { plan: 'trial' } })]} />)
    expect(screen.queryByText('Attributes')).not.toBeInTheDocument()
    expect(toggleFor('page_view')).toHaveAttribute('aria-expanded', 'false')
  })

  // The four columns are a summary. Expanding is the only place in the
  // product that answers "what exactly did you receive", so it has to show
  // the fields no column has room for -- including the custom properties,
  // which is the whole reason someone opens a row.
  it('expands on click and lists every attribute and property the event carried', async () => {
    render(
      <AcceptedTable
        events={[
          event({
            properties: { plan: 'trial' },
            properties_num: { seats: 12 },
            utm_campaign: 'launch',
            browser: 'firefox',
          }),
        ]}
      />,
    )
    await userEvent.click(eventCell('page_view'))

    expect(toggleFor('page_view')).toHaveAttribute('aria-expanded', 'true')
    // The event's own properties, both maps -- the string/number split is
    // a storage detail of two ClickHouse columns, not something the sender
    // should have to reassemble.
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText('trial')).toBeInTheDocument()
    expect(screen.getByText('seats')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    // And the attributes with no column of their own.
    expect(screen.getByText('UTM campaign')).toBeInTheDocument()
    expect(screen.getByText('launch')).toBeInTheDocument()
    expect(screen.getByText('firefox')).toBeInTheDocument()
    // The full instant, not the row's own time-of-day rendering.
    expect(screen.getByText('2026-08-15T09:14:02.000Z')).toBeInTheDocument()
    // The id, which is what an operator needs to go looking in ClickHouse.
    expect(screen.getByText('e1')).toBeInTheDocument()
  })

  it('collapses again on a second click', async () => {
    render(<AcceptedTable events={[event({ properties: { plan: 'trial' } })]} />)
    await userEvent.click(eventCell('page_view'))
    expect(screen.getByText('Attributes')).toBeInTheDocument()
    await userEvent.click(eventCell('page_view'))
    expect(screen.queryByText('Attributes')).not.toBeInTheDocument()
  })

  it('is reachable by keyboard through the row chevron', async () => {
    render(<AcceptedTable events={[event({ properties: { plan: 'trial' } })]} />)
    toggleFor('page_view').focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('Attributes')).toBeInTheDocument()
    // Once, not twice: the chevron's own click must not also reach the
    // row's handler, or the panel would open and close in one press.
    expect(toggleFor('page_view')).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens one row at a time', async () => {
    render(
      <AcceptedTable
        events={[
          event({ event_id: 'e1', event_name: 'page_view' }),
          event({ event_id: 'e2', event_name: 'signed_up' }),
        ]}
      />,
    )
    await userEvent.click(eventCell('page_view'))
    await userEvent.click(eventCell('signed_up'))
    expect(toggleFor('page_view')).toHaveAttribute('aria-expanded', 'false')
    expect(toggleFor('signed_up')).toHaveAttribute('aria-expanded', 'true')
  })

  // The feed re-renders from a fresh poll every few seconds and a new event
  // shifts every row down by one. Keyed by index, the open panel would stay
  // put and quietly start describing a DIFFERENT event -- properties that
  // are not the ones the reader clicked, with nothing on screen to say so.
  it('keeps the panel on the event it was opened for when a new event arrives', async () => {
    const older = event({ event_id: 'e1', event_name: 'page_view', properties: { plan: 'trial' } })
    const { rerender } = render(<AcceptedTable events={[older]} />)
    await userEvent.click(eventCell('page_view'))
    expect(screen.getByText('trial')).toBeInTheDocument()

    // Oldest-first on the wire, so the newcomer is appended; the table
    // reverses for display, which puts it above the open row.
    const newer = event({ event_id: 'e2', event_name: 'signed_up', properties: { plan: 'pro' } })
    rerender(<AcceptedTable events={[older, newer]} />)

    expect(toggleFor('page_view')).toHaveAttribute('aria-expanded', 'true')
    expect(toggleFor('signed_up')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('trial')).toBeInTheDocument()
    expect(screen.queryByText('pro')).not.toBeInTheDocument()
  })

  // "Not shown" and "not received" are different facts. Nineteen built-in
  // attributes rendered as em dashes would bury the six a browser event
  // actually carries, so the empty ones are dropped -- and counted, so the
  // panel never implies it listed everything.
  it('drops empty attributes but says how many it dropped', async () => {
    render(<AcceptedTable events={[event({ user_id: '', referrer: '' })]} />)
    await userEvent.click(eventCell('page_view'))
    expect(screen.queryByText('User ID')).not.toBeInTheDocument()
    expect(screen.queryByText('Referrer')).not.toBeInTheDocument()
    expect(screen.getByText(/arrived empty on this event/)).toBeInTheDocument()
  })

  it('says so plainly when an event carried no properties', async () => {
    render(<AcceptedTable events={[event()]} />)
    await userEvent.click(eventCell('page_view'))
    const properties = screen.getByRole('heading', { name: 'Properties' })
      .parentElement as HTMLElement
    expect(within(properties).getByText('This event carried no properties.')).toBeInTheDocument()
  })

  // A property whose value is the empty string is a property the sender
  // wrote, unlike an attribute that never arrived -- so it is listed, and
  // marked, rather than dropped by the same rule.
  it('lists a property with an empty value rather than hiding it', async () => {
    render(<AcceptedTable events={[event({ properties: { plan: '' } })]} />)
    await userEvent.click(eventCell('page_view'))
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })
})

describe('AcceptedTable linkPeople', () => {
  it('links the person cell only when asked', async () => {
    render(<AcceptedTable events={[event({ user_id: 'u1' })]} linkPeople />, { wrapper: Router })
    expect(screen.getByRole('link', { name: 'u1' })).toHaveAttribute('href', '/people?id=u1')

    cleanup()
    render(<AcceptedTable events={[event({ user_id: 'u1' })]} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('links an anonymous row by its anonymous id', () => {
    // resolvePersonScope's step 4 falls back to a device lookup, so an
    // anonymous_id resolves to whoever owns that device.
    render(<AcceptedTable events={[event({ user_id: '', anonymous_id: 'dev-9' })]} linkPeople />, {
      wrapper: Router,
    })
    expect(screen.getByRole('link', { name: 'dev-9' })).toHaveAttribute('href', '/people?id=dev-9')
  })

  it('does not toggle the row when the link itself is clicked', async () => {
    // The row's own onClick opens the detail panel; the link inside it
    // stops that click reaching the row, the same way the chevron does, or
    // a reader trying to follow the stitching to a profile would open the
    // row instead every time.
    render(<AcceptedTable events={[event({ user_id: 'u1' })]} linkPeople />, { wrapper: Router })
    await userEvent.click(screen.getByRole('link', { name: 'u1' }))
    expect(screen.queryByText('Attributes')).not.toBeInTheDocument()
  })

  // The icon marks "this link resolves", not "this cell is a link" -- both
  // rows link, so the pair below is what actually pins the rule. Asserting
  // presence on the identified row alone would also pass a version that
  // put the icon on every linked row, which is exactly the thing C2 ruled
  // out.
  it('marks an identified row with a person icon inside the link', () => {
    render(<AcceptedTable events={[event({ user_id: 'u1' })]} linkPeople />, { wrapper: Router })
    const link = screen.getByRole('link', { name: 'u1' })
    expect(link.querySelector('svg')).not.toBeNull()
  })

  it('does not mark an anonymous-only row with the person icon', () => {
    // Same event shape as "links an anonymous row by its anonymous id" --
    // the link still resolves to a device owner via resolvePersonScope's
    // step 4, but nothing here confirms it, so the icon must not claim it
    // does.
    render(<AcceptedTable events={[event({ user_id: '', anonymous_id: 'dev-9' })]} linkPeople />, {
      wrapper: Router,
    })
    const link = screen.getByRole('link', { name: 'dev-9' })
    expect(link.querySelector('svg')).toBeNull()
  })
})
