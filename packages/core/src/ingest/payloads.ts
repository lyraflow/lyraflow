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
