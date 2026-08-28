import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { EventsPage, LyraEvent, Person } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { People } from './People.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

const PERSON: Person = {
  person_id: 'u1',
  ids: ['u1'],
  devices: [],
  first_seen: '2026-06-01T09:00:00.000Z',
  last_seen: '2026-08-20T15:30:00.000Z',
  events: 42,
  traits: {},
  traits_num: {},
  trait_total: 0,
  traits_withheld: false,
}

function person(overrides: Partial<Person> = {}): Person {
  return { ...PERSON, ...overrides }
}

/** The context fields an event that carried none of them still arrives with
 * on the wire -- ClickHouse has no null here, matching
 * `AcceptedTable.test.tsx`'s own fixture. */
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
    timestamp: '2026-08-20T15:30:00.000Z',
    event_name: 'page_view',
    anonymous_id: 'anon_1',
    user_id: '',
    properties: {},
    properties_num: {},
    path: '',
    ...over,
  }
}

function eventsPage(events: LyraEvent[] = [], over: Partial<EventsPage> = {}): EventsPage {
  return { events, next_cursor: null, prev_cursor: null, ...over }
}

/** A client whose `events` resolves to an empty, single (`ended`) page --
 * used by every test above the timeline that has nothing to say about it:
 * the person read is what those tests are about, and the timeline mounting
 * underneath must not crash them while contributing nothing to what they
 * assert. */
function noTimeline() {
  return vi.fn(async () => eventsPage())
}

function renderPeople(path: string, client: ApiClient, opts: { onUnauthorized?: () => void } = {}) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <People client={client} onUnauthorized={opts.onUnauthorized} />
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('People', () => {
  it('shows a lookup input when there is no id', () => {
    const client = { person: vi.fn() } as unknown as ApiClient
    renderPeople('/people', client)
    expect(screen.getByLabelText(/user id, anonymous id, or a device id/i)).toBeInTheDocument()
    expect(client.person).not.toHaveBeenCalled()
  })

  it('names all three reasons a person cannot be shown', async () => {
    // person.ts's own docstring: a 404 means nobody ever sent this id, OR
    // everything they did sits at or before their deletion boundary, OR
    // every event aged out under retention -- "there is no way to tell the
    // three apart from this response alone". Saying "no such person" would
    // tell an operator checking an erasure that it worked when it may have
    // been a retention expiry.
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=ghost', client)
    const msg = await screen.findByTestId('person-not-found')
    // The brief's own illustrative regex here (`/never/i`) does not match
    // the verbatim-preserved copy, which reads "no event was ever
    // recorded" rather than containing the literal substring "never" --
    // same shape of correction `PersonFields.test.tsx` already made for
    // `AttributesSection`'s copy. Pinning the real phrasing for each of
    // the three causes instead, which is the assertion this test exists to
    // make: an operator must be told all three, not shown a message loose
    // enough to also describe "no such person".
    expect(msg).toHaveTextContent(/no event was ever recorded/i)
    expect(msg).toHaveTextContent(/erased by a deletion request/i)
    expect(msg).toHaveTextContent(/retention window/i)
    expect(msg).not.toHaveTextContent(/no such person/i)
  })

  it('explains a fragmented history rather than showing a broken screen', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(400, 'person_history_too_fragmented')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=busy', client)
    // Same correction as above: the brief's illustrative `/too many
    // devices/i` does not appear in the verbatim 400 copy, which names the
    // limit (200) instead.
    expect(await screen.findByText(/more than 200 device windows/i)).toBeInTheDocument()
    expect(screen.getByText(/lyraflow persons get/)).toBeInTheDocument()
  })

  it('keeps what was typed when a lookup 404s, so it can be corrected', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
    } as unknown as ApiClient
    renderPeople('/people', client)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/user id/i), 'cem@exampl.com')
    await user.click(screen.getByRole('button', { name: /look up/i }))
    expect(await screen.findByDisplayValue('cem@exampl.com')).toBeInTheDocument()
    expect(client.person).toHaveBeenCalledWith(1, 'cem@exampl.com')
  })

  it('renders the id set split into user ids and device ids', async () => {
    // The one thing no other screen shows: that these ids are ONE person is
    // the product's central claim, and nothing in the UI has ever
    // displayed it.
    const client = {
      person: vi.fn(async () =>
        person({ person_id: 'u1', ids: ['u1', 'u2', 'dev-a'], devices: ['dev-a'] }),
      ),
      events: noTimeline(),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByTestId('identity-ids')).toHaveTextContent('dev-a')
  })

  it('renders traits from the person read', async () => {
    const client = {
      person: vi.fn(async () => person({ traits: { plan: 'pro' }, traits_num: { seats: 12 } })),
      events: noTimeline(),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText('plan')).toBeInTheDocument()
    expect(screen.getByText('pro')).toBeInTheDocument()
  })

  it('says traits were withheld rather than that there are none', async () => {
    const client = {
      person: vi.fn(async () => person({ traits: {}, trait_total: 0, traits_withheld: true })),
      events: noTimeline(),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText(/cannot be split/i)).toBeInTheDocument()
  })

  it('calls onUnauthorized on a 401 rather than rendering an error', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client, { onUnauthorized })
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('anchors the timeline to the person read, not to the URL', async () => {
    // Task 7's own placeholder is gone -- this is the real timeline now,
    // and this test pins the one thing People.tsx itself is responsible
    // for handing it: last_seen from the profile just read, not some other
    // instant.
    const events: Mock = vi.fn(async () => eventsPage())
    const client = {
      person: vi.fn(async () => person({ last_seen: '2026-08-20T15:30:00.000Z' })),
      events,
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    await waitFor(() => expect(events).toHaveBeenCalled())
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      person: 'u1',
      until: '2026-08-20T15:30:00.000Z',
    })
  })

  it('leaves the header and traits standing when the timeline fails', async () => {
    // The panels render independently: the header/traits/context come from
    // the person read and the timeline from a second fetch, and either can
    // fail alone. A timeline error must not blank a header that rendered
    // fine.
    const client = {
      person: vi.fn(async () => person({ person_id: 'u1', traits: { plan: 'pro' } })),
      events: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText('pro')).toBeInTheDocument()
    // Awaited, not `getByText`: the person read and the timeline are two
    // separate fetches, and the timeline's own only starts once the person
    // read has already landed and mounted it -- it needs its own tick to
    // reject and re-render, even though both promises resolve immediately.
    expect(await screen.findByText(/could not load .*timeline/i)).toBeInTheDocument()
  })

  it('says the context is unknown when there is no newest event to read it from', async () => {
    // Context comes off the timeline's first row. With no timeline there is
    // nothing to read, and ten empty rows would assert this person has no
    // device, browser or country -- which the screen never established.
    const client = {
      person: vi.fn(async () => person({ person_id: 'u1' })),
      events: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText(/no context to show/i)).toBeInTheDocument()
    expect(screen.queryByText(/have no value recorded/i)).toBeNull()
  })

  it('fills the context panel from the timeline once it loads', async () => {
    // The other half of the pair above: once the timeline's newest event
    // does land, the context panel reads it rather than staying stuck on
    // "no context to show".
    const client = {
      person: vi.fn(async () => person({ person_id: 'u1' })),
      events: vi.fn(async () => eventsPage([event({ browser: 'firefox' })])),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText('firefox')).toBeInTheDocument()
    expect(screen.queryByText(/no context to show/i)).toBeNull()
  })
})

// Invented mutation: a component that shows the profile view regardless of
// which error came back would pass every test above individually if each
// one only checked for ITS OWN message being present -- this proves the
// three failure states are mutually exclusive on screen, not just each
// independently reachable.
describe('People -- invented mutations', () => {
  it('never renders the profile view on a 404, even though the same client mock would resolve for another id', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
      events: noTimeline(),
    } as unknown as ApiClient
    renderPeople('/people?id=ghost', client)
    await screen.findByTestId('person-not-found')
    expect(screen.queryByTestId('identity-ids')).toBeNull()
    // Never reached: the timeline never mounts behind a 404, so the second
    // fetch it would have made is never sent either.
    expect(client.events).not.toHaveBeenCalled()
  })

  it('never calls the export or delete endpoints -- this task builds neither', async () => {
    const personExport = vi.fn()
    const deletePerson = vi.fn()
    const client = {
      person: vi.fn(async () => person()),
      events: noTimeline(),
      personExport,
      deletePerson,
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    await screen.findByTestId('identity-ids')
    expect(personExport).not.toHaveBeenCalled()
    expect(deletePerson).not.toHaveBeenCalled()
  })
})
