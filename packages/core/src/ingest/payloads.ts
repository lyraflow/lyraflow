import { z } from 'zod'
import { MAX_ID_LENGTH, MAX_URL_LENGTH, MAX_USER_AGENT_LENGTH } from './properties.js'

const id = z.string().min(1).max(MAX_ID_LENGTH)
const propertyValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
const propertyBag = z.record(propertyValue)

const Context = z
  .object({
    url: z.string().max(MAX_URL_LENGTH).optional(),
    path: z.string().max(MAX_URL_LENGTH).optional(),
    referrer: z.string().max(MAX_URL_LENGTH).optional(),
    user_agent: z.string().max(MAX_USER_AGENT_LENGTH).optional(),
    // Which SDK sent this. The ecosystem convention (Segment's
    // context.library, PostHog's $lib, Amplitude's library), and the signal
    // that keeps a server-side SDK from being dropped as a bot -- its HTTP
    // client's User-Agent says `python-requests`, which is indistinguishable
    // from a scraper and was, until this field existed, treated as one.
    //
    // Both halves required when present: an SDK that cannot state its own
    // version is a bug, and a half-filled object looks like a declaration
    // while carrying nothing to support it. Only `name` drives any decision;
    // `version` is for support and future per-SDK reporting.
    //
    // `.catch(undefined)` is what keeps that rule from destroying data.
    // `Context` is a plain object schema, so it runs in Zod's STRIP mode:
    // before `library` was a known key, a client sending a Segment-shaped
    // `context.library` -- a bare string, or `{name}` with no version --
    // simply had it dropped and the event was stored. Naming the key
    // inverts that silently: the value stops being unknown-and-ignored and
    // becomes known-and-invalid, so the whole event fails validation. The
    // sender still gets a 202, so the only evidence is a dead-letter row
    // they never look at, and their entire stream disappears.
    //
    // So an unusable value is IGNORED, exactly as it was before this field
    // existed, rather than being fatal. The rule that a half-filled library
    // is not a declaration survives -- an ignored value is `undefined`, and
    // `undefined` exempts nothing from the bot filter -- but it costs the
    // sender only the events sent under a bot-looking user agent, instead of
    // every event they send.
    library: z
      .object({
        name: z.string().min(1).max(MAX_ID_LENGTH),
        version: z.string().min(1).max(MAX_ID_LENGTH),
      })
      .optional()
      .catch(undefined),
    utm_source: z.string().max(MAX_ID_LENGTH).optional(),
    utm_medium: z.string().max(MAX_ID_LENGTH).optional(),
    utm_campaign: z.string().max(MAX_ID_LENGTH).optional(),
    utm_term: z.string().max(MAX_ID_LENGTH).optional(),
    utm_content: z.string().max(MAX_ID_LENGTH).optional(),
  })
  .default({})

const identified = {
  message_id: z.string().uuid(),
  anonymous_id: id.optional(),
  user_id: id.optional(),
  timestamp: z.string().optional(),
  context: Context,
}

/** At least one identifier is required, otherwise the event belongs to nobody. */
const hasIdentifier = (p: { anonymous_id?: string; user_id?: string }) =>
  Boolean(p.anonymous_id || p.user_id)
const identifierError = { message: 'anonymous_id or user_id is required' }

export const TrackPayload = z
  .object({
    ...identified,
    type: z.literal('track'),
    event: id,
    properties: propertyBag.default({}),
  })
  .refine(hasIdentifier, identifierError)

export const PagePayload = z
  .object({
    ...identified,
    type: z.literal('page'),
    name: id.optional(),
    properties: propertyBag.default({}),
  })
  .refine(hasIdentifier, identifierError)

export const IdentifyPayload = z.object({
  ...identified,
  type: z.literal('identify'),
  user_id: id,
  traits: propertyBag.default({}),
})

export const IngestPayload = z
  // `._def.schema` unwraps the ZodEffects that `.refine()` wraps each payload
  // in, because z.discriminatedUnion accepts only plain ZodObjects. Unwrapping
  // therefore *discards* the hasIdentifier refinement, which is why the
  // superRefine below re-applies it — without that, every anonymous_id-less,
  // user_id-less track and page event would validate here even though
  // TrackPayload/PagePayload reject it on their own.
  //
  // Both halves must move together. If a Zod upgrade changes this internal
  // shape (the `_def` prefix marks it as unstable), fix the unwrap and the
  // re-application as one change — dropping the superRefine silently reopens
  // the identifier gap, and `payloads.test.ts` is what catches it.
  .discriminatedUnion('type', [TrackPayload._def.schema, PagePayload._def.schema, IdentifyPayload])
  .superRefine((p, ctx) => {
    if (p.type !== 'identify' && !hasIdentifier(p)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, ...identifierError })
    }
  })

/**
 * The batch envelope deliberately does NOT validate its items. Each item is
 * validated individually at ingest so that one malformed event cannot cause
 * the whole batch — including every valid event in it — to be rejected.
 */
export const BatchPayload = z.object({ batch: z.array(z.unknown()).min(1).max(500) })

export type TrackPayload = z.infer<typeof TrackPayload>
export type PagePayload = z.infer<typeof PagePayload>
export type IdentifyPayload = z.infer<typeof IdentifyPayload>
export type IngestPayload = z.infer<typeof IngestPayload>
