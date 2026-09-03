import { DEFAULT_GRACE_HOURS, MAX_GRACE_HOURS, rotateWriteKey } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import type { ProjectCache } from '../auth/project-cache.js'

export interface ProjectDeps {
  authenticate: Authenticate
  pg: Pool
  /**
   * The SAME instance app.ts shares with every other project-scoped
   * registration -- PATCH /v1/project must invalidate the exact cache the
   * retention worker and the ingest quota check read from, not a second,
   * lookalike instance that would leave those two acting on stale numbers
   * for up to 60s after the API said otherwise.
   */
  projects: ProjectCache
}

/**
 * Bounds copied from the column's own CHECK constraint
 * (`projects_retention_months_range`, 001_core.sql). Validating here rather
 * than letting Postgres refuse the write is the difference between a 400 a
 * caller can act on and a constraint violation, which app.ts's catch-all
 * renders as `503 {"error":"unavailable"}` -- indistinguishable from an
 * outage.
 */
const PatchBody = z
  .object({
    retention_months: z.number().int().min(1).max(120).optional(),
    // `.nullable()` and `.optional()` are different things here and the
    // difference is the whole point: absent means "leave it alone", null
    // means "unlimited", and 0 is neither -- isOverQuota THROWS on 0 rather
    // than treating it as a limit, so admitting it would 503 every event of
    // the project. The positive() bound is what keeps them apart.
    //
    // `.max(Number.MAX_SAFE_INTEGER)` -- IMPORTANT 2 from the whole-branch
    // review. `int()` alone does not bound the value: `1e20` passes it (it
    // is exactly representable as a float) and reaches Postgres as a
    // `bigint` column write far outside that type's range, which Postgres
    // refuses -- and at `1e21` the value serialises as the literal string
    // `"1e+21"`, which Postgres refuses for an entirely different reason
    // (invalid syntax for `bigint`). Both surfaced as `503 unavailable`
    // through app.ts's generic error handler, indistinguishable from an
    // outage, for what is a deterministic, catchable client error. The
    // client (`LimitsSection.tsx`'s `parseQuota`) now rejects this before
    // the request is even sent, but the server bound has to hold on its
    // own regardless of what any particular client does.
    monthly_event_quota: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
  })
  .refine((b) => b.retention_months !== undefined || b.monthly_event_quota !== undefined, {
    message: 'empty patch',
  })

const RotateBody = z
  .object({
    grace_hours: z.number().int().min(0).max(MAX_GRACE_HOURS).default(DEFAULT_GRACE_HOURS),
  })
  .strict()

/**
 * The project's own identity, including the write key.
 *
 * The two keys are not peers. The WRITE key is public by construction: it
 * ships inside the browser bundle and is readable in devtools on any
 * instrumented page, and it authenticates ingest only. The SERVER key is a
 * secret: it authenticates every read path, is stored as a SHA-256 hash, and
 * is unrecoverable. A caller holding the server key can already read every
 * person, event and segment in the project, so handing it a value printed on
 * the customer's own website widens nothing.
 *
 * This route exists because the write key was otherwise unreadable after
 * project creation -- printed once by `create-project` and served by
 * nothing -- so a self-hoster who lost it had no recovery but raw SQL.
 *
 * NEVER serialise the cached `Project` here. It carries `serverKeyHash`,
 * which segment cursor signing uses as an HMAC key; project-cache.ts's
 * docstring records that nothing in this codebase puts it on the wire, and
 * this route is the first that serialises anything project-shaped. Build
 * the response field by field, as below, and source `name`/`write_key` from
 * a direct Postgres read -- the cache does not carry either.
 */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDeps): void {
  const { authenticate, pg, projects } = deps

  app.get('/v1/project', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    // Scoped by the authenticated project's id -- never by anything a caller
    // could put on the request -- so no query parameter can select another
    // project's row.
    const res = await pg.query<{ name: string; slug: string; write_key: string }>(
      'SELECT name, slug, write_key FROM projects WHERE id = $1',
      [project.id],
    )
    const row = res.rows[0]
    // This response varies entirely on the `x-lyraflow-server-key` header,
    // which the response carries no `Vary` for, and it is the first route in
    // this codebase whose 200 body is a credential (the write key). A shared
    // cache keying on URL alone -- ignoring the auth header -- could serve
    // one project's write key back out to a different caller. See
    // privacy/export.ts's identical `no-store` for the same reasoning
    // applied to a subject-access response.
    reply.header('cache-control', 'no-store')
    if (!row) return reply.code(404).send({ error: 'project_not_found' })

    return reply.code(200).send({
      name: row.name,
      slug: row.slug,
      write_key: row.write_key,
    })
  })

  app.patch('/v1/project', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const body = PatchBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })

    // COALESCE against the parameter, so an absent field keeps its stored
    // value in one statement without building SQL by concatenation. The
    // quota's `undefined` is normalised to a sentinel first, because
    // COALESCE cannot tell "absent" from "explicitly null" on its own.
    const quotaGiven = body.data.monthly_event_quota !== undefined
    const res = await pg.query<{ retention_months: number; monthly_event_quota: string | null }>(
      `UPDATE projects
          SET retention_months    = COALESCE($2, retention_months),
              monthly_event_quota = CASE WHEN $3 THEN $4 ELSE monthly_event_quota END
        WHERE id = $1
        RETURNING retention_months, monthly_event_quota`,
      [
        project.id,
        body.data.retention_months ?? null,
        quotaGiven,
        body.data.monthly_event_quota ?? null,
      ],
    )
    const row = res.rows[0]
    if (!row) return reply.code(404).send({ error: 'project_not_found' })

    // ProjectCache caches retentionMonths and monthlyEventQuota for 60s, and
    // both drive live behaviour -- the retention worker's partition drops and
    // the ingest quota check. Without this, the API reports a new limit that
    // is not in force for up to a minute.
    projects.invalidate()

    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      retention_months: row.retention_months,
      monthly_event_quota:
        row.monthly_event_quota === null ? null : Number(row.monthly_event_quota),
    })
  })

  /**
   * Replace the project's write key. The old key stays valid for
   * `grace_hours` (default 24, 0 for a hard swap) so pages still serving
   * the previous snippet keep collecting while caches turn over; after
   * that they get `401 invalid_write_key`, which the browser SDK treats as
   * final. Server key OR session: a server-key holder can already read the
   * write key (GET /v1/project) and delete every person in the project, so
   * this widens nothing.
   */
  app.post('/v1/project/rotate-write-key', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const body = RotateBody.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })

    const rotated = await rotateWriteKey(pg, project.id, body.data.grace_hours * 3_600_000)
    if (!rotated) return reply.code(404).send({ error: 'project_not_found' })

    // Same reason PATCH gives: the old key is cached positive for up to a
    // minute in this process. With a grace that is harmless; with a hard
    // swap it is exactly the window the caller asked to close.
    projects.invalidate()

    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      write_key: rotated.writeKey,
      previous_write_key_expires_at: rotated.previousWriteKeyExpiresAt?.toISOString() ?? null,
    })
  })

  app.get('/v1/project/usage', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const res = await pg.query<{
      events_accepted: string
      events_rejected: string
      events_throttled: string
      events_bot: string
    }>(
      `SELECT events_accepted, events_rejected, events_throttled, events_bot
         FROM ingest_counters
        WHERE project_id = $1 AND month = date_trunc('month', now())::date`,
      [project.id],
    )
    // A project's first event of the month has no row, and that is ordinary
    // rather than exceptional -- so every field defaults to 0 rather than
    // going through Number(undefined), which is NaN and serialises to null.
    const row = res.rows[0]
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      month: new Date().toISOString().slice(0, 7),
      events_accepted: row ? Number(row.events_accepted) : 0,
      events_rejected: row ? Number(row.events_rejected) : 0,
      events_throttled: row ? Number(row.events_throttled) : 0,
      // Bot drops are reported SEPARATELY from rejections rather than folded
      // into them. Before migration 015 a crawler hit counted as `rejected`,
      // so a project taking real traffic plus crawler traffic showed a large
      // "Rejected" number that was mostly not a fault at all; splitting the
      // column without reporting the new one here would have been worse
      // still -- the rejections would read 0 and the crawler traffic would
      // appear nowhere, which is the exact question 015 exists to answer.
      events_bot: row ? Number(row.events_bot) : 0,
      monthly_event_quota: project.monthlyEventQuota,
    })
  })
}
