import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProjectDeletionStore } from './deletion-store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new ProjectDeletionStore(pg)

// A prefix no other suite uses, so cleanup here can never touch another
// file's rows even though they share a live database.
const PREFIX = 'projdelstore'
let counter = 0

/**
 * Raw INSERT rather than `@lyraflow/core`'s `createProject`: that helper
 * derives the slug from `name` via `slugify`, and every test below calls
 * this with the same name ('Acme') -- `slug` is UNIQUE, so a shared slug
 * would collide across tests. `write_key` and `server_key_hash` need no
 * real key material here; nothing under test reads them.
 */
async function createProject(
  db: Pool,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  const slug = `${PREFIX}-${Date.now()}-${counter++}`
  const r = await db.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_${slug}`],
  )
  return { id: Number(r.rows[0]?.id), slug, name }
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterEach: a run that died mid-suite
  // would otherwise leave rows from a previous attempt for the next run's
  // first claim() test to collide with (see the afterEach comment below for
  // why claim() makes this whole table fair game).
  await pg.query('DELETE FROM project_deletions')
  await pg.query(`DELETE FROM projects WHERE slug LIKE '${PREFIX}-%'`)
})

// `claim()` is deliberately NOT scoped to a project -- it is a global "next
// thing to do" query (see ProjectDeletionStore.claim). Wiping the whole
// table after every test, not just this file's own rows, is what keeps the
// claim tests deterministic. Safe only because vitest.config.ts sets
// `fileParallelism: false`.
afterEach(async () => {
  await pg.query('DELETE FROM project_deletions')
  await pg.query(`DELETE FROM projects WHERE slug LIKE '${PREFIX}-%'`)
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('ProjectDeletionStore', () => {
  it('stamps deleting_at and inserts the queue row in one transaction', async () => {
    const project = await createProject(pg, 'Acme')
    const result = await store.request(project.id)
    expect(result).toEqual({ id: expect.any(Number) })

    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeInstanceOf(Date)

    const req = await store.get((result as { id: number }).id)
    expect(req).toMatchObject({ projectId: project.id, slug: project.slug, name: 'Acme' })
  })

  it('refuses a second request and reports the first', async () => {
    const project = await createProject(pg, 'Acme')
    const first = (await store.request(project.id)) as { id: number }
    expect(await store.request(project.id)).toEqual({ alreadyDeleting: first.id })
    const rows = await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [
      project.id,
    ])
    expect(Number(rows.rows[0].count)).toBe(1)
  })

  it('answers not_found for an unknown project without inserting anything', async () => {
    expect(await store.request(999_999)).toBe('not_found')
    const rows = await pg.query('SELECT count(*) FROM project_deletions')
    expect(Number(rows.rows[0].count)).toBe(0)
  })

  it('claims one request under a lease and increments attempts', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    const claimed = await store.claim({ leaseMs: 60_000, maxAttempts: 5 })
    expect(claimed?.attempts).toBe(1)
    // A second claim inside the lease window finds nothing.
    expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5 })).toBeNull()
  })

  it('re-claims a request whose lease has expired', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    await store.claim({ leaseMs: 60_000, maxAttempts: 5 })
    await pg.query(
      "UPDATE project_deletions SET claimed_at = now() - interval '2 hours' WHERE project_id = $1",
      [project.id],
    )
    const again = await store.claim({ leaseMs: 60_000, maxAttempts: 5 })
    expect(again?.attempts).toBe(2)
  })

  it('stops handing out a request past maxAttempts', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    await pg.query(
      'UPDATE project_deletions SET attempts = 5, claimed_at = NULL WHERE project_id = $1',
      [project.id],
    )
    expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5 })).toBeNull()
  })

  it('truncates a pathological last_error', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await store.request(project.id)) as { id: number }
    await store.fail(id, 'x'.repeat(5000))
    const req = await store.get(id)
    expect(req?.lastError).toHaveLength(2000)
  })

  it('leaves neither write behind when the transaction fails', async () => {
    const project = await createProject(pg, 'Acme')
    // Force the INSERT to fail: a NOT NULL column fed a null by a poisoned
    // name is not reachable through the API, so drop the table's NOT NULL
    // expectation by deleting the project row mid-flight instead.
    await pg.query('DROP INDEX project_deletions_pending_idx')
    await pg.query('ALTER TABLE project_deletions ADD CONSTRAINT boom CHECK (false) NOT VALID')
    await pg.query('ALTER TABLE project_deletions VALIDATE CONSTRAINT boom').catch(() => {})
    await expect(store.request(project.id)).rejects.toThrow()
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    await pg.query('ALTER TABLE project_deletions DROP CONSTRAINT boom')
    await pg.query(
      'CREATE INDEX project_deletions_pending_idx ON project_deletions (requested_at) WHERE completed_at IS NULL',
    )
  })
})
