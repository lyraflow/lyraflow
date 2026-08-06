import { createPgPool } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectExistsError, createProject, slugify } from './create-project.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const NAME = 'CLI Dup Test'

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slugify(NAME)])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slugify(NAME)])
  await pg.end()
})

describe('createProject', () => {
  it('creates a project and returns both keys', async () => {
    const project = await createProject(pg, NAME)
    expect(project.slug).toBe('cli-dup-test')
    expect(project.writeKey).toMatch(/^wk_[0-9a-f]{32}$/)
    expect(project.serverKey).toMatch(/^sk_[0-9a-f]{48}$/)
  })

  it('reports a clear message instead of a raw Postgres unique-violation when run twice', async () => {
    // `create-project` is the first command the README gives a new self-hoster,
    // so running it twice is an ordinary mistake. Before the fix this rejected
    // with node-pg's own error — the user saw a stack ending in
    // `duplicate key value violates unique constraint "projects_slug_key"`.
    //
    // Mutation caught: deleting the try/catch in createProject. The rejection
    // is then the driver's error, which is not a ProjectExistsError and whose
    // message does not mention the slug or what to do about it.
    await expect(createProject(pg, NAME)).rejects.toBeInstanceOf(ProjectExistsError)
    await expect(createProject(pg, NAME)).rejects.toThrow(/already exists/)
    await expect(createProject(pg, NAME)).rejects.toThrow(/cli-dup-test/)
    await expect(createProject(pg, NAME)).rejects.not.toThrow(/unique constraint/)
  })
})
