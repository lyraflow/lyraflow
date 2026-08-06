import { createPgPool } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PersonAliases } from './aliases.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
let projectId: number
let aliases: PersonAliases

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['aliases-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Aliases', 'aliases-test', 'wk_aliases', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM person_aliases WHERE project_id = $1', [projectId])
  aliases = new PersonAliases(pg)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['aliases-test'])
  await pg.end()
})

describe('PersonAliases', () => {
  it('merges one person into another', async () => {
    expect(await aliases.alias(projectId, 'a', 'b')).toBe('merged')
    expect(await aliases.canonicalFor(projectId, 'a')).toBe('b')
    expect(await aliases.canonicalFor(projectId, 'b')).toBe('b')
  })

  it('returns the id unchanged when it has no alias', async () => {
    expect(await aliases.canonicalFor(projectId, 'nobody')).toBe('nobody')
  })

  it('keeps chains flat: a→b then b→c repoints a to c directly', async () => {
    await aliases.alias(projectId, 'a', 'b')
    await aliases.alias(projectId, 'b', 'c')
    expect(await aliases.canonicalFor(projectId, 'a')).toBe('c')
    const r = await pg.query<{ person_id: string; canonical_id: string }>(
      'SELECT person_id, canonical_id FROM person_aliases WHERE project_id = $1 ORDER BY person_id',
      [projectId],
    )
    expect(r.rows).toEqual([
      { person_id: 'a', canonical_id: 'c' },
      { person_id: 'b', canonical_id: 'c' },
    ])
  })

  it('treats a reversing alias as a no-op instead of creating a cycle', async () => {
    await aliases.alias(projectId, 'a', 'b')
    expect(await aliases.alias(projectId, 'b', 'a')).toBe('noop')
    expect(await aliases.canonicalFor(projectId, 'a')).toBe('b')
    expect(await aliases.canonicalFor(projectId, 'b')).toBe('b')
  })

  it('is a no-op when both sides already share a canonical', async () => {
    await aliases.alias(projectId, 'a', 'c')
    await aliases.alias(projectId, 'b', 'c')
    expect(await aliases.alias(projectId, 'a', 'b')).toBe('noop')
  })

  it('is a no-op when aliasing a person to itself', async () => {
    expect(await aliases.alias(projectId, 'a', 'a')).toBe('noop')
  })

  it('scopes aliases per project', async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('AliasOther', 'aliases-other', 'wk_aliases_other', 'h') RETURNING id`,
    )
    const otherId = Number(other.rows[0]?.id)
    await aliases.alias(projectId, 'a', 'b')
    expect(await aliases.canonicalFor(otherId, 'a')).toBe('a')
    await pg.query('DELETE FROM projects WHERE slug = $1', ['aliases-other'])
  })

  // The two tests above never put two projects in real contention: the
  // second project has zero person_aliases rows at the moment the merge
  // runs, so a dropped project_id filter has nothing of the other
  // project's to collide with. These two tests manufacture that collision
  // deliberately — same person_id/canonical_id values reused across
  // projects — so a missing scope on either of alias()'s two internal
  // queries (the canonical() resolve and the flattening UPDATE) has
  // something real to corrupt.
  it("does not repoint another project's canonical group when merging", async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('AliasContentionUpdate', 'aliases-contention-update', 'wk_aliases_cu', 'h')
       RETURNING id`,
    )
    const otherId = Number(other.rows[0]?.id)
    try {
      // Both projects alias 'x' into the same canonical group name 'g' —
      // a collision the flattening UPDATE (WHERE canonical_id = $2) would
      // find if it weren't also scoped by project_id.
      await aliases.alias(projectId, 'x', 'g')
      await aliases.alias(otherId, 'x', 'g')

      const before = await pg.query<{ person_id: string; canonical_id: string }>(
        'SELECT person_id, canonical_id FROM person_aliases WHERE project_id = $1 ORDER BY person_id',
        [otherId],
      )

      // Repoints project A's 'g' group at 'h'. If the UPDATE weren't
      // scoped to project_id, this would also repoint project B's
      // canonical_id = 'g' row.
      expect(await aliases.alias(projectId, 'x', 'h')).toBe('merged')
      expect(await aliases.canonicalFor(projectId, 'x')).toBe('h')
      expect(await aliases.canonicalFor(projectId, 'g')).toBe('h')

      const after = await pg.query<{ person_id: string; canonical_id: string }>(
        'SELECT person_id, canonical_id FROM person_aliases WHERE project_id = $1 ORDER BY person_id',
        [otherId],
      )
      expect(after.rows).toEqual(before.rows)
      expect(after.rows).toEqual([{ person_id: 'x', canonical_id: 'g' }])
    } finally {
      await pg.query('DELETE FROM projects WHERE slug = $1', ['aliases-contention-update'])
    }
  })

  it("does not resolve a person's canonical against another project's alias", async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('AliasContentionResolve', 'aliases-contention-resolve', 'wk_aliases_cr', 'h')
       RETURNING id`,
    )
    const otherId = Number(other.rows[0]?.id)
    try {
      // Project B aliases 'p' to 'q'. Project A has never aliased 'p' at
      // all — canonical('p') inside alias() must resolve to 'p' itself
      // for project A, not read project B's row for the same person_id.
      await aliases.alias(otherId, 'p', 'q')

      expect(await aliases.alias(projectId, 'p', 'r')).toBe('merged')
      // Correct resolution: project A's 'p' had no alias, so it merges
      // directly into 'r'. A resolve that ignored project scoping would
      // instead pick up 'q' from project B, merge 'q' into 'r', and leave
      // project A's 'p' un-aliased.
      expect(await aliases.canonicalFor(projectId, 'p')).toBe('r')
      // Project B's own alias must be untouched by project A's merge.
      expect(await aliases.canonicalFor(otherId, 'p')).toBe('q')
    } finally {
      await pg.query('DELETE FROM projects WHERE slug = $1', ['aliases-contention-resolve'])
    }
  })
})
