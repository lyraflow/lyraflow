import { createHash, randomBytes } from 'node:crypto'

/**
 * The one database capability `createProject` needs, declared locally rather
 * than imported.
 *
 * `core` is pure domain logic with no I/O, so it takes no database
 * dependency: importing `Pool` from `@lyraflow/db` is a circular project
 * reference (`db` already references `core`), and depending on `pg` directly
 * would put a database driver in the dependencies of a package that is also
 * consumed, via tests, alongside a browser bundle with a hard size ceiling.
 * A structural type costs nothing and `pg`'s own Pool satisfies it, so every
 * existing caller passes unchanged.
 */
export interface ProjectStore {
  query(text: string, params: unknown[]): Promise<unknown>
}

export interface CreatedProject {
  // Every field GET /v1/projects lists for a project, so a caller can add
  // this row to an in-memory list without a second round trip -- plus the
  // two one-time keys, which appear here and nowhere else. `id` and
  // `monthlyEventQuota` come back from Postgres as strings (bigint/bigserial
  // are returned as strings by node-pg to avoid precision loss); the caller
  // converts, exactly as GET /v1/projects's own row mapping already does.
  id: string
  name: string
  slug: string
  createdAt: Date
  retentionMonths: number
  monthlyEventQuota: string | null
  writeKey: string
  serverKey: string
}

/**
 * Raised when a project with the same slug already exists. `create-project` is
 * the first command the README tells a new self-hoster to run, and running it
 * twice (a re-read of the install instructions, a lost write key) is an
 * entirely ordinary mistake. Answering it with a raw Postgres unique-violation
 * stack reads as "the product is broken", so this carries a message a person
 * can act on instead.
 */
export class ProjectExistsError extends Error {
  constructor(readonly slug: string) {
    super(
      `A project with slug "${slug}" already exists. Project names must be unique. Pick a different name, or look up the existing project's write key in the projects table.`,
    )
    this.name = 'ProjectExistsError'
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 (unique_violation), surfaced by node-pg as `code`.
  return (err as { code?: unknown } | null)?.code === '23505'
}

export async function createProject(pg: ProjectStore, name: string): Promise<CreatedProject> {
  const slug = slugify(name)
  const writeKey = `wk_${randomBytes(16).toString('hex')}`
  const serverKey = `sk_${randomBytes(24).toString('hex')}`

  // RETURNING rather than a hardcoded copy of the columns' defaults: `id` is
  // only known once the row exists, and `retention_months` /
  // `monthly_event_quota` already drifted from their originally-shipped
  // defaults once (010_retention_default.sql, 011_quota.sql) -- reading them
  // back is what keeps this correct across the next such migration too,
  // instead of silently reporting a value the row was never given.
  let result: unknown
  try {
    result = await pg.query(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at, retention_months, monthly_event_quota`,
      [name, slug, writeKey, createHash('sha256').update(serverKey).digest('hex')],
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProjectExistsError(slug)
    throw err
  }

  const row = (
    result as {
      rows: Array<{
        id: string
        created_at: Date
        retention_months: number
        monthly_event_quota: string | null
      }>
    }
  ).rows[0]
  if (!row) throw new Error('createProject: INSERT ... RETURNING produced no row')

  return {
    name,
    slug,
    writeKey,
    serverKey,
    id: row.id,
    createdAt: row.created_at,
    retentionMonths: row.retention_months,
    monthlyEventQuota: row.monthly_event_quota,
  }
}
