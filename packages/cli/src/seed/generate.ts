/**
 * The demo-data generator: turns a seed and three counts into a population,
 * its identity bindings and its events. Pure — no database, no clock, no
 * `Math.random()` — so the whole shape of the data can be tested without
 * either database running.
 *
 * WHY THE DATA IS NOT SEEDED THROUGH THE PUBLIC INGEST API. Every client
 * timestamp is clamped to within `MAX_CLOCK_SKEW_MS` (24h) of the moment it
 * arrives — see `clampTimestamp` in @lyraflow/core, whose own docstring
 * explains why an unclamped device clock poisons every time-windowed segment.
 * That clamp is correct and is deliberately left alone. It does, however, mean
 * that posting ninety days of backdated events to `/v1/batch` produces ninety
 * days of events all landing inside a single day: `last 7 days`, `last 30
 * days` and `ever` would give the same answer, and a funnel-over-time chart
 * would be a single column. So this command writes to the databases directly
 * instead, and the README says so where an operator will read it.
 *
 * It still builds each row with `toEventRow` — the same function the ingest
 * route uses — rather than assembling the row shape a second time. The clamp
 * is reused too, not bypassed: `rows.ts` passes the event's own instant as
 * `now`, which is inside the skew window by construction, so `clampTimestamp`
 * returns it unchanged. See `toDemoRow` for why that is the whole trick.
 *
 * EVERYTHING IN HERE IS OBVIOUSLY SYNTHETIC, on purpose. Ids are prefixed
 * `demo-`, hostnames use the reserved `.invalid` TLD, names are "Demo Person
 * 0042", and there are no email addresses at all. Demo data ends up in
 * screenshots, issue attachments and public documentation; nothing here may be
 * mistakable for a real person or a real company.
 */

import type { IngestPayload, PropertyValue, UserAgentInfo } from '@lyraflow/core'
import { eventNameFor, parseUserAgent } from '@lyraflow/core'
import type { GeoInfo } from '@lyraflow/server/dist/ingest/geo.js'
import { UsageError } from '../api/args.js'
import {
  type Rng,
  floatBetween,
  intBetween,
  mulberry32,
  pick,
  roundedBetween,
  weighted,
} from './random.js'

/** Ordered exactly as a person walks them; index 0 is the funnel's entry. */
export const FUNNEL_EVENTS = [
  // `$page`, not 'page_view'. A page view is stored under one name with the
  // page's own name as a property (#53), so the demo funnel's first step is
  // "viewed any page" -- which is what it always meant and could not say.
  '$page',
  'signup_started',
  'signup_completed',
  'checkout_started',
  'purchase',
] as const

/**
 * The chance of taking each step GIVEN the step before it. Index 0 is 1 —
 * everyone enters — and the rest are the drop-off.
 *
 * These are the reason the funnel screen is worth looking at: a funnel where
 * everyone converts carries exactly as much information as an empty one. They
 * are also why `signup_completed`'s rate is high while `checkout_started`'s is
 * not — the interesting cliff in a real product is at the paywall, and a demo
 * that puts it somewhere else teaches an evaluator the wrong shape.
 *
 * `signup_completed` is also the identity boundary: a person who reaches it
 * identifies (and so carries traits), and a person who does not stays
 * anonymous forever. That coupling is what makes the demo exercise identity
 * resolution rather than merely mention it.
 */
export const FUNNEL_RATES = [1, 0.8, 0.875, 0.55, 0.62] as const

/** Reaching this step index (0-based) is what makes a person identified. */
export const IDENTIFY_STEP = 2

/** Events every person contributes regardless of `--events`: their funnel
 * steps, plus the `$identify` if they reached it. */
function reservedFor(depth: number): number {
  return depth + (depth > IDENTIFY_STEP ? 1 : 0)
}

/** Event names that exist purely so the feed and the behavioural predicates
 * have something other than the funnel to match on. */
// `$page` is a SENTINEL here rather than an event name to send: it selects
// the page-payload branch below, and the payload's own `name` is the page's,
// not this. Spelled as the stored name so the two cannot be read as different
// things.
const FILLER_EVENTS = ['$page', 'feature_used', 'docs_search', 'invite_sent'] as const

const PLANS = [
  ['free', 6],
  ['pro', 3],
  ['enterprise', 1],
] as const

/** country, region, city — the geo triple `toEventRow` expects. */
const LOCATIONS = [
  ['US', 'CA', 'Demo City'],
  ['US', 'NY', 'Demo Harbour'],
  ['GB', 'ENG', 'Demo Bridge'],
  ['DE', 'BE', 'Demo Garten'],
  ['FR', 'IDF', 'Demo Rive'],
  ['NL', 'NH', 'Demo Kanaal'],
  ['BR', 'SP', 'Demo Praia'],
  ['JP', '13', 'Demo Bay'],
  ['AU', 'NSW', 'Demo Cove'],
  ['CA', 'ON', 'Demo Falls'],
] as const

const SIGNUP_SOURCES = [
  ['organic_search', 5],
  ['newsletter', 3],
  ['partner_demo', 2],
  ['conference_booth', 1],
  ['word_of_mouth', 2],
] as const

/**
 * First-touch acquisition: utm_source, utm_medium, utm_campaign. The empty
 * triple is direct traffic and is deliberately present — a context predicate
 * on `utm_source` has to have something to exclude, and "no campaign" is the
 * commonest value in every real project.
 */
const FIRST_TOUCH = [
  ['', '', ''],
  ['newsletter', 'email', 'demo-digest'],
  ['demo-search', 'cpc', 'demo-launch'],
  ['demo-social', 'social', 'demo-launch'],
  ['demo-partner', 'referral', 'demo-partners'],
  ['demo-docs', 'organic', 'demo-docs'],
] as const

const REFERRERS = [
  '',
  'https://search.invalid/',
  'https://social.invalid/feed',
  'https://partner.invalid/tools',
] as const

/**
 * Run through `parseUserAgent` rather than writing `device_type`/`os`/
 * `browser` out by hand, so the demo rows carry exactly the values real ingest
 * derives — including its lowercasing and its device-type rules. A
 * hand-written triple would drift the first time that parser is taught
 * something new.
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
] as const

/** path, and the short label used as a `page` property. */
const PAGES = [
  ['/', 'home'],
  ['/pricing', 'pricing'],
  ['/docs', 'docs'],
  ['/docs/segments', 'docs-segments'],
  ['/changelog', 'changelog'],
  ['/signup', 'signup'],
  ['/app/dashboard', 'dashboard'],
] as const

const FEATURES = ['segments', 'funnels', 'feed', 'exports', 'api-keys'] as const
const DOC_QUERIES = ['segment window', 'funnel drop-off', 'identify', 'retention', 'batch api']
const INVITE_CHANNELS = ['link', 'email_invite', 'slack_share'] as const
const SIGNUP_METHODS = ['email', 'sso'] as const

/** `.invalid` is reserved by RFC 2606 and can never resolve, so no URL here
 * can ever point at a real site. */
const HOST = 'https://app.lyraflow-demo.invalid'

const DAY_MS = 86_400_000

/** The fraction of persons whose location changes partway through their
 * history, so `scope: latest` and `scope: first_touch` on a context field give
 * genuinely different answers instead of agreeing by accident. */
const TRAVEL_SHARE = 0.15

export interface SeedOptions {
  seed: number
  persons: number
  events: number
  days: number
  /** The instant the newest data is measured back from. */
  anchor: Date
}

export interface DemoPerson {
  /** 1-based, and part of every id this person owns. */
  ordinal: number
  /** The `user_id` an identified person carries; `''` while anonymous. */
  personId: string
  anonymousId: string
  identified: boolean
  /** How many of `FUNNEL_EVENTS` this person reached, 1..5. */
  funnelDepth: number
  traits: Record<string, PropertyValue>
  firstAt: Date
  lastAt: Date
  /** When the `$identify` landed, and therefore when the binding is bound. */
  identifyAt: Date | null
}

export interface DemoEvent {
  /** The event's own instant. `rows.ts` uses it for BOTH the payload timestamp
   * and `toEventRow`'s `now`; see `toDemoRow`. */
  at: Date
  payload: IngestPayload
  geo: GeoInfo
  ua: UserAgentInfo
}

export interface DemoBinding {
  anonymousId: string
  personId: string
  boundAt: Date
}

export interface DemoData {
  options: SeedOptions
  persons: DemoPerson[]
  events: DemoEvent[]
  bindings: DemoBinding[]
}

/**
 * Message ids are derived from the seed and the event's ordinal rather than
 * drawn from the generator, so they are unique BY CONSTRUCTION rather than
 * with high probability, and two different seeds can never mint the same id.
 *
 * The consequence is worth stating because it is visible to an operator: a
 * second run at the SAME seed re-mints the same ids. Nothing here deletes and
 * nothing rejects a repeat, so the project ends up holding two events with one
 * id at two different instants. That is a deliberate trade — it makes an
 * accidental double-run *detectable* (`SELECT event_id FROM events GROUP BY
 * event_id HAVING count() > 1`) instead of invisible. The command's help text
 * says so.
 */
function messageId(seed: number, ordinal: number): string {
  return `${idPrefix(seed)}-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`
}

function idPrefix(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0')
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

interface Timeline {
  firstAt: Date
  funnelAt: Date[]
  identifyAt: Date | null
  lastAt: Date
  travelAt: Date | null
}

interface PersonContext {
  ua: UserAgentInfo
  geo: GeoInfo
  travelGeo: GeoInfo
  touch: readonly [string, string, string]
  referrer: string
}

interface DrawnPerson {
  person: DemoPerson
  timeline: Timeline
  context: PersonContext
}

/**
 * One person, drawn in a FIXED order. That order is the determinism contract:
 * inserting a draw in the middle shifts every value after it, so a change here
 * changes what every seed means. It is one function rather than three so there
 * is exactly one place the order lives.
 */
function drawPerson(rng: Rng, opts: SeedOptions, ordinal: number): DrawnPerson {
  const prefix = idPrefix(opts.seed)

  let funnelDepth = 1
  for (let step = 1; step < FUNNEL_RATES.length; step++) {
    if (rng() >= (FUNNEL_RATES[step] as number)) break
    funnelDepth = step + 1
  }
  const identified = funnelDepth > IDENTIFY_STEP

  const timeline = drawTimeline(rng, opts, funnelDepth, identified)

  const home = pick(rng, LOCATIONS)
  const away = pick(rng, LOCATIONS)
  const ua = parseUserAgent(pick(rng, USER_AGENTS))
  const touch = pick(rng, FIRST_TOUCH)
  const referrer = pick(rng, REFERRERS)

  const plan = weighted(rng, PLANS)
  const signupSource = weighted(rng, SIGNUP_SOURCES)
  const seats = plan === 'enterprise' ? intBetween(rng, 25, 400) : intBetween(rng, 1, 24)
  const mrrUsd =
    plan === 'free'
      ? 0
      : roundedBetween(rng, plan === 'pro' ? 19 : 400, plan === 'pro' ? 290 : 9_400, 2)
  const isTrial = plan !== 'free' && rng() < 0.3

  return {
    person: {
      ordinal,
      personId: identified ? `demo-person-${prefix}-${pad4(ordinal)}` : '',
      anonymousId: `demo-device-${prefix}-${pad4(ordinal)}`,
      identified,
      funnelDepth,
      // Mixed on purpose. `display_name`/`plan`/`country`/`signup_source` are
      // strings and land in `properties`; `seats`/`mrr_usd` are numbers and
      // land in `properties_num`; `is_trial` is a boolean, which
      // `routeProperties` stringifies into `properties`. All three branches of
      // that router are exercised by every identified person, so a predicate
      // on any of them has something to match.
      traits: {
        display_name: `Demo Person ${pad4(ordinal)}`,
        plan,
        country: home[0],
        signup_source: signupSource,
        is_trial: isTrial,
        seats,
        mrr_usd: mrrUsd,
      },
      firstAt: timeline.firstAt,
      lastAt: timeline.lastAt,
      identifyAt: timeline.identifyAt,
    },
    timeline,
    context: {
      ua,
      geo: { country: home[0], region: home[1], city: home[2] },
      travelGeo: { country: away[0], region: away[1], city: away[2] },
      touch,
      referrer,
    },
  }
}

function drawTimeline(rng: Rng, opts: SeedOptions, depth: number, identified: boolean): Timeline {
  const anchorMs = opts.anchor.getTime()

  // Half a day is the floor, so a person's whole first session — at most four
  // gaps of at most ninety minutes — always finishes before the anchor, and no
  // event is ever generated in the future.
  const firstAgeMs = floatBetween(rng, 0.5, opts.days) * DAY_MS
  const firstMs = Math.round(anchorMs - firstAgeMs)

  const funnelMs: number[] = [firstMs]
  for (let step = 1; step < depth; step++) {
    funnelMs.push((funnelMs[step - 1] as number) + intBetween(rng, 30_000, 5_400_000))
  }
  const sessionEndMs = funnelMs[funnelMs.length - 1] as number

  const identifyMs = identified
    ? (funnelMs[IDENTIFY_STEP] as number) + intBetween(rng, 1_000, 60_000)
    : null

  // How much of their available lifetime the person stayed active for. 1.0
  // means still active at the anchor, which is what keeps `last 7 days`
  // populated for persons who first appeared months ago.
  const activeFraction = floatBetween(rng, 0.15, 1)
  const lastMs = Math.max(
    Math.round(anchorMs - firstAgeMs * (1 - activeFraction)),
    sessionEndMs + 60_000,
  )

  const travelAt = rng() < TRAVEL_SHARE ? new Date(Math.round((sessionEndMs + lastMs) / 2)) : null

  return {
    firstAt: new Date(firstMs),
    funnelAt: funnelMs.map((ms) => new Date(ms)),
    identifyAt: identifyMs === null ? null : new Date(identifyMs),
    lastAt: new Date(lastMs),
    travelAt,
  }
}

/**
 * Splits `total` filler events across persons, weighted so a person who got
 * further down the funnel is busier afterwards too, and summing to EXACTLY
 * `total`. The leftover from the integer division is handed out one per person
 * from the start of the list — a deterministic tie-break, which matters more
 * here than an even one.
 */
export function allocate(weights: number[], total: number): number[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  const counts = weights.map((w) => Math.floor((total * w) / sum))
  let leftover = total - counts.reduce((a, b) => a + b, 0)
  for (let i = 0; leftover > 0; i = (i + 1) % counts.length) {
    counts[i] = (counts[i] as number) + 1
    leftover--
  }
  return counts
}

interface EventDraft {
  at: Date
  /** Generation order, used only to make the sort below total. */
  order: number
  build: (id: string) => Omit<DemoEvent, 'at'>
}

export function generateDemoData(opts: SeedOptions): DemoData {
  if (!Number.isInteger(opts.persons) || opts.persons < 1) {
    throw new UsageError('--persons must be a positive whole number')
  }
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    throw new UsageError('--days must be a positive whole number')
  }
  if (!Number.isInteger(opts.events) || opts.events < 1) {
    throw new UsageError('--events must be a positive whole number')
  }

  const rng = mulberry32(opts.seed)

  const drawn: DrawnPerson[] = []
  for (let ordinal = 1; ordinal <= opts.persons; ordinal++) {
    drawn.push(drawPerson(rng, opts, ordinal))
  }
  const persons = drawn.map((d) => d.person)

  const reserved = persons.reduce((sum, p) => sum + reservedFor(p.funnelDepth), 0)
  if (opts.events < reserved) {
    throw new UsageError(
      `--events is too small for the number of persons requested: their funnel and identify events alone need at least ${reserved}`,
    )
  }

  const fillerCounts = allocate(
    persons.map((p) => 1 + p.funnelDepth),
    opts.events - reserved,
  )

  const drafts: EventDraft[] = []
  const bindings: DemoBinding[] = []

  for (let i = 0; i < drawn.length; i++) {
    const { person, timeline, context } = drawn[i] as DrawnPerson
    const geoAt = (at: Date): GeoInfo =>
      timeline.travelAt !== null && at.getTime() >= timeline.travelAt.getTime()
        ? context.travelGeo
        : context.geo
    const identifiedAt = (ms: number): boolean =>
      person.identifyAt !== null && ms >= person.identifyAt.getTime()

    for (let step = 0; step < person.funnelDepth; step++) {
      const at = timeline.funnelAt[step] as Date
      const properties = funnelProperties(rng, step, person)
      const page = pick(rng, PAGES)
      const identity = {
        anonymous_id: person.anonymousId,
        ...(identifiedAt(at.getTime()) ? { user_id: person.personId } : {}),
      }
      drafts.push({
        at,
        order: drafts.length,
        build: (id) => ({
          payload:
            step === 0
              ? {
                  type: 'page',
                  // The PAGE's name, which is what this field always meant.
                  // It reaches storage as the `$page_name` property.
                  name: page[1],
                  message_id: id,
                  ...identity,
                  properties,
                  context: {
                    url: `${HOST}${page[0]}`,
                    path: page[0],
                    // Referrer and the UTM trio are attached to the FIRST
                    // event only. device_index records them with argMin over
                    // the timestamp, so a later event carrying them would not
                    // change the answer anyway — but omitting them later is
                    // what makes "first touch" true of the DATA rather than
                    // merely true of the query.
                    referrer: context.referrer,
                    utm_source: context.touch[0],
                    utm_medium: context.touch[1],
                    utm_campaign: context.touch[2],
                  },
                }
              : {
                  type: 'track',
                  event: FUNNEL_EVENTS[step] as string,
                  message_id: id,
                  ...identity,
                  properties,
                  context: { url: `${HOST}${page[0]}`, path: page[0] },
                },
          geo: geoAt(at),
          ua: context.ua,
        }),
      })
    }

    if (person.identified && person.identifyAt !== null) {
      const at = person.identifyAt
      drafts.push({
        at,
        order: drafts.length,
        build: (id) => ({
          payload: {
            type: 'identify',
            message_id: id,
            anonymous_id: person.anonymousId,
            user_id: person.personId,
            traits: person.traits,
            context: {},
          },
          geo: geoAt(at),
          ua: context.ua,
        }),
      })
      bindings.push({ anonymousId: person.anonymousId, personId: person.personId, boundAt: at })
    }

    // Filler starts a minute after the first session ends, so it can never be
    // mistaken for part of the funnel walk and can never precede the first
    // touch that carries the campaign.
    const from = (timeline.funnelAt[timeline.funnelAt.length - 1] as Date).getTime() + 60_000
    const to = Math.max(person.lastAt.getTime(), from)
    const instants: number[] = []
    for (let n = 0; n < (fillerCounts[i] as number); n++) {
      instants.push(Math.round(floatBetween(rng, from, to + 1)))
    }
    instants.sort((a, b) => a - b)

    for (const ms of instants) {
      const at = new Date(ms)
      const name = pick(rng, FILLER_EVENTS)
      const page = pick(rng, PAGES)
      const properties = fillerProperties(rng, name, page[1])
      const identity = {
        anonymous_id: person.anonymousId,
        ...(identifiedAt(ms) ? { user_id: person.personId } : {}),
      }
      drafts.push({
        at,
        order: drafts.length,
        build: (id) => ({
          payload:
            name === '$page'
              ? {
                  type: 'page',
                  name: page[1],
                  message_id: id,
                  ...identity,
                  properties,
                  context: { url: `${HOST}${page[0]}`, path: page[0] },
                }
              : {
                  type: 'track',
                  event: name,
                  message_id: id,
                  ...identity,
                  properties,
                  context: { url: `${HOST}${page[0]}`, path: page[0] },
                },
          geo: geoAt(at),
          ua: context.ua,
        }),
      })
    }
  }

  // Sorted by instant, with the generation order as the tie-break so the
  // ordering is total and therefore reproducible. Message ids are assigned
  // from the SORTED position, so the id sequence follows the timeline — which
  // makes a hand-check of the oldest or newest rows straightforward.
  drafts.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order)

  const events: DemoEvent[] = drafts.map((draft, index) => ({
    at: draft.at,
    ...draft.build(messageId(opts.seed, index + 1)),
  }))

  return { options: opts, persons, events, bindings }
}

function funnelProperties(
  rng: Rng,
  step: number,
  person: DemoPerson,
): Record<string, PropertyValue> {
  const plan = String(person.traits.plan)
  switch (FUNNEL_EVENTS[step]) {
    case '$page':
      return { page: 'landing', duration_ms: intBetween(rng, 400, 22_000) }
    case 'signup_started':
      return { method: pick(rng, SIGNUP_METHODS) }
    case 'signup_completed':
      return { method: pick(rng, SIGNUP_METHODS), invited_teammates: intBetween(rng, 0, 6) }
    case 'checkout_started':
      return { plan, amount: roundedBetween(rng, 19, 9_400, 2), currency: 'USD' }
    default:
      return {
        plan,
        amount: roundedBetween(rng, 19, 9_400, 2),
        currency: 'USD',
        items: intBetween(rng, 1, 5),
      }
  }
}

function fillerProperties(rng: Rng, name: string, page: string): Record<string, PropertyValue> {
  switch (name) {
    case 'feature_used':
      return { feature: pick(rng, FEATURES), duration_ms: intBetween(rng, 120, 90_000) }
    case 'docs_search':
      return { query: pick(rng, DOC_QUERIES), results: intBetween(rng, 0, 40) }
    case 'invite_sent':
      return { channel: pick(rng, INVITE_CHANNELS), invitees: intBetween(rng, 1, 12) }
    default:
      return { page, duration_ms: intBetween(rng, 400, 240_000) }
  }
}

/**
 * Re-exported from core rather than reimplemented, which is what it always
 * claimed to be: "every event's name, exactly as `toEventRow` will derive it".
 * It was a THIRD copy of that rule (#53 counted two), and a seeder whose event
 * names drift from ingest's stops resembling production data, which is the
 * only reason the seeder exists.
 */
export const eventNameOf = eventNameFor

export interface DemoSummary {
  events: number
  persons: number
  identifiedPersons: number
  anonymousPersons: number
  bindings: number
  earliest: Date
  latest: Date
  /** Distinct event names with a count each, ordered by name. */
  byEvent: Array<{ event: string; count: number }>
  /** Persons reaching each funnel step, in step order. */
  funnel: Array<{ event: string; persons: number }>
  /** Events inside the last 7 / 30 days and in total, against the anchor. */
  windows: { last7: number; last30: number; ever: number }
}

/** Counted from the generated data, never predicted from the rates — the
 * summary an operator reads has to be the truth about what was written. */
export function summarise(data: DemoData): DemoSummary {
  const counts = new Map<string, number>()
  for (const ev of data.events) {
    const name = eventNameOf(ev.payload)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const anchorMs = data.options.anchor.getTime()
  const times = data.events.map((e) => e.at.getTime())

  return {
    events: data.events.length,
    persons: data.persons.length,
    identifiedPersons: data.persons.filter((p) => p.identified).length,
    anonymousPersons: data.persons.filter((p) => !p.identified).length,
    bindings: data.bindings.length,
    earliest: new Date(Math.min(...times)),
    latest: new Date(Math.max(...times)),
    byEvent: [...counts.entries()]
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0)),
    funnel: FUNNEL_EVENTS.map((event, step) => ({
      event,
      persons: data.persons.filter((p) => p.funnelDepth > step).length,
    })),
    windows: {
      last7: times.filter((t) => t >= anchorMs - 7 * DAY_MS).length,
      last30: times.filter((t) => t >= anchorMs - 30 * DAY_MS).length,
      ever: times.length,
    },
  }
}
