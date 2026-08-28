import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { EventsPage, LyraEvent } from '../../api/types.js'
import { TIMELINE_PAGE, Timeline } from './Timeline.js'

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

/** `id` is used as both the event's name (so a test can find its own row by
 * text) and a suffix of its id (so two events are never accidentally the
 * same row). */
function ev(id: string, timestamp: string, over: Partial<LyraEvent> = {}): LyraEvent {
  return {
    ...EMPTY_CONTEXT,
    event_id: `evt-${id}`,
    timestamp,
    event_name: id,
    anonymous_id: 'anon_1',
    user_id: '',
    properties: {},
    properties_num: {},
    path: '',
    ...over,
  }
}

function page(events: LyraEvent[], over: Partial<EventsPage> = {}): EventsPage {
  return { events, next_cursor: null, prev_cursor: null, ...over }
}

const T1 = '2026-08-01T09:00:00.000Z'
const T2 = '2026-08-02T09:00:00.000Z'
const FIRST_SEEN = '2026-06-01T09:00:00.000Z'
const LAST_SEEN = '2026-08-20T15:30:00.000Z'

function base(client: ApiClient) {
  return { client, projectId: 1, personId: 'u1', firstSeen: FIRST_SEEN, lastSeen: LAST_SEEN }
}

describe('Timeline', () => {
  it('anchors the first page to the person at BOTH ends, not to the last 24 hours', async () => {
    // THE TRAP THIS EXISTS FOR, and this test used to assert the trap
    // itself. It was named for the anchor and pinned
    // `since === undefined` -- which is precisely the request that returns
    // nothing for anyone last seen over a day ago, because `/v1/events`
    // gates its 24h `since` default on `!cursor` ALONE. `until` does not
    // turn it off, so `until: lastSeen` with no `since` compiles to
    // `timestamp >= now-24h AND timestamp <= lastSeen`: an empty
    // intersection, no rows, and no `prev_cursor` to start the walk from.
    //
    // Measured against the live stack, which is how it was found rather
    // than argued: a person with events at -30h and -25h returned
    // `{"events":[]}` for that exact request and both events once `since`
    // was set to their `first_seen`.
    //
    // So `since` must be SENT, and it must be `first_seen`. A new event
    // landing between the profile read and this one can only move
    // `last_seen` forward; it can never move `first_seen` backward, so the
    // floor stays valid.
    const events: Mock = vi.fn(async () => page([]))
    const client = { events } as unknown as ApiClient
    render(
      <Timeline
        {...base(client)}
        firstSeen="2026-01-04T08:00:00.000Z"
        lastSeen="2026-06-01T10:00:00.000Z"
      />,
    )
    await waitFor(() => expect(events).toHaveBeenCalled())
    expect(events.mock.calls[0]?.[1]).toMatchObject({
      person: 'u1',
      since: '2026-01-04T08:00:00.000Z',
      until: '2026-06-01T10:00:00.000Z',
      limit: TIMELINE_PAGE,
    })
  })

  it('sends no since on an older page, leaving the cursor to bound the scan', async () => {
    // The other half of the same guard, and the one a fix for the first
    // half is most likely to break by making `since` unconditional. A
    // cursor is ITSELF a bound on the scan; a second, tighter floor
    // underneath it silently drops everything between the cursor and the
    // window edge, which is the defect `events/routes.ts`'s own `!cursor`
    // comment was written for. `before` pages carry the cursor and nothing
    // else.
    const events: Mock = vi
      .fn()
      .mockResolvedValueOnce(page([ev('new', T2)], { prev_cursor: 'CUR' }))
      .mockResolvedValueOnce(page([ev('old', T1)], { prev_cursor: null }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    await userEvent.click(await screen.findByRole('button', { name: /load older/i }))
    expect(events.mock.calls[1]?.[1]).toMatchObject({ person: 'u1', before: 'CUR' })
    expect(events.mock.calls[1]?.[1].since).toBeUndefined()
    expect(events.mock.calls[1]?.[1].until).toBeUndefined()
  })

  it('renders newest first, reversing the ascending response', async () => {
    // Every response from /v1/events is ascending. The feed renders it that
    // way (a log reads oldest-first); a profile does not.
    const events = vi.fn(async () => page([ev('a', T1), ev('b', T2)], { prev_cursor: null }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByText('b')).toBeInTheDocument()
  })

  it('loads older events with the prev_cursor, appending beneath', async () => {
    const events: Mock = vi
      .fn()
      .mockResolvedValueOnce(page([ev('new', T2)], { prev_cursor: 'CUR' }))
      .mockResolvedValueOnce(page([ev('old', T1)], { prev_cursor: null }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    await userEvent.click(await screen.findByRole('button', { name: /load older/i }))
    expect(events.mock.calls[1]?.[1]).toMatchObject({ before: 'CUR' })
    expect(await screen.findByText('old')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
  })

  it('stops offering older when a page comes back empty', async () => {
    const events: Mock = vi
      .fn()
      .mockResolvedValueOnce(page([ev('a', T2)], { prev_cursor: 'CUR' }))
      .mockResolvedValueOnce(page([], { prev_cursor: 'CUR' }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    await userEvent.click(await screen.findByRole('button', { name: /load older/i }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /load older/i })).toBeNull())
    expect(screen.getByText(/that is their whole history/i)).toBeInTheDocument()
  })

  it('explains a fragmented history from the timeline without blanking the screen', async () => {
    // The same 400 the person read can return. A 400 here must not look
    // like a broken screen when the header above it rendered fine.
    const events = vi.fn(async () => {
      throw new ApiError(400, 'person_history_too_fragmented')
    })
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    expect(await screen.findByText(/too many devices/i)).toBeInTheDocument()
  })

  it('reports a generic failure without blanking the screen', async () => {
    const events = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    })
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    expect(await screen.findByText(/could not load .*timeline/i)).toBeInTheDocument()
  })

  it('hands the newest event up so the context panel can read it', async () => {
    const onNewestEvent = vi.fn()
    const events = vi.fn(async () => page([ev('a', T1), ev('b', T2)], { prev_cursor: null }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} onNewestEvent={onNewestEvent} />)
    await waitFor(() =>
      expect(onNewestEvent).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'evt-b' })),
    )
  })

  it('reports an empty first page as null rather than staying silent', async () => {
    // "There is nothing to read" is an answer and the context panel needs
    // it. Staying silent leaves that panel in the same state as "the
    // timeline has not come back yet", and it then tells the operator the
    // timeline has not loaded for a timeline that loaded fine -- see
    // `People.tsx`'s `Context` type.
    const onNewestEvent = vi.fn()
    const events = vi.fn(async () => page([]))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} onNewestEvent={onNewestEvent} />)
    await waitFor(() => expect(onNewestEvent).toHaveBeenCalledWith(null))
  })

  it('stays silent when the first page fails, rather than reporting it as empty', async () => {
    // The third state, and the reason the guard is on the `.then()` and not
    // on the promise: a failed timeline has established NOTHING about this
    // person's data, so reporting `null` here would let the panel claim
    // there was nothing to read when nobody ever managed to look.
    const onNewestEvent = vi.fn()
    const events = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    })
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} onNewestEvent={onNewestEvent} />)
    expect(await screen.findByText(/could not load .*timeline/i)).toBeInTheDocument()
    expect(onNewestEvent).not.toHaveBeenCalled()
  })
})

// Invented mutation: a Timeline that reversed its accumulated array a
// SECOND time before handing it to AcceptedTable (which already reverses
// once, for display) would cancel the two reversals out and pass every
// single-page test that only checks a page's own events are all present --
// this multi-page test is the one that would show the top of the list
// reading oldest-first instead.
describe('Timeline -- invented mutations', () => {
  it('keeps a later, older page below the first page rather than above it', async () => {
    const events: Mock = vi
      .fn()
      .mockResolvedValueOnce(page([ev('new', T2)], { prev_cursor: 'CUR' }))
      .mockResolvedValueOnce(page([ev('old', T1)], { prev_cursor: null }))
    const client = { events } as unknown as ApiClient
    render(<Timeline {...base(client)} />)
    await userEvent.click(await screen.findByRole('button', { name: /load older/i }))
    await screen.findByText('old')
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByText('new')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('old')).toBeInTheDocument()
  })
})
