import { z } from 'zod'
import { FilterNode, MAX_WHERE_PREDICATES, WherePredicate } from '../segments/ast.js'

/**
 * One step: an event, and optional constraints on THAT event's own
 * properties.
 *
 * `where` is the segment `WherePredicate` verbatim rather than a parallel
 * shape. A caller writes the same predicate in a segment and in a funnel
 * step, and `predicates.ts` compiles it identically in both — a second
 * spelling would be two grammars for one idea, and the operator list is
 * exactly where that drift would first show up.
 *
 * A step is deliberately NOT a filter tree. A segment is a claim about a
 * person over all time; a step must be a claim about one event at one
 * instant, or "did step 2 happen after step 1" has no single instant to
 * compare and the question stops being well-formed.
 */
export const FunnelStep = z.object({
  event: z.string().min(1).max(128),
  where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
  /**
   * WHICH PERSON may advance through this step, as opposed to `where`, which
   * says WHICH OCCURRENCE of the event counts. The segment `FilterNode`
   * verbatim, for the same reason `where` is the segment `WherePredicate`
   * verbatim: a second grammar for one idea drifts.
   *
   * It gates the step rather than the funnel. The funnel-wide `segment_id`
   * is applied outside the per-person aggregate and removes a person from
   * the report entirely; this is folded INTO the step's own condition, so
   * someone who satisfies step 1 and fails step 2's audience is still
   * counted as having reached step 1. That difference is the whole reason
   * this field exists rather than a second `segment_id`.
   *
   * The window inside it is anchored to `now`, exactly as a segment's is.
   * For a run over an older range that judges a person against today rather
   * than against their own entry; the builder says so out loud.
   */
  audience: FilterNode.optional(),
})
export type FunnelStep = z.infer<typeof FunnelStep>

/**
 * `window_seconds` is on the DEFINITION; `since`/`until` are not.
 *
 * They are two different clocks. The window is a property of the funnel —
 * how long someone gets to finish once they have started. The range is a
 * property of the question being asked this time. Storing the range would
 * make "the signup funnel, last week" and "the signup funnel, this week" two
 * separate rows describing one funnel.
 *
 * Two steps is the floor: a one-step "funnel" is a count, and
 * `GET /v1/events/stats` already answers that better than this ever will.
 */
export const FunnelDefinition = z.object({
  steps: z.array(FunnelStep).min(2),
  window_seconds: z.number().int().positive(),
  segment_id: z.number().int().positive().nullable().optional(),
})
export type FunnelDefinition = z.infer<typeof FunnelDefinition>

/**
 * Stored in its own column, not merely inside the `steps` JSON, so a later
 * migration can find every v1 definition without parsing every row — the
 * same reasoning `segments.ast_version` was given.
 *
 * 2 since step audiences. A v1 definition still parses byte-identically —
 * `audience` is optional and no saved row carries it — so this is NOT a
 * "would parse differently" bump. It is the other kind: the definition now
 * embeds a SEPARATELY VERSIONED grammar, and when `AST_VERSION` next moves a
 * migration must find every funnel carrying an embedded tree.
 * `definition_version >= 2` is the only way to do that without parsing every
 * row, which is exactly what this column is for. Every new write carries 2
 * whether or not any step has an audience; readers accept 1 and 2.
 */
export const FUNNEL_DEFINITION_VERSION = 2
