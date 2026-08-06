import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from '@lyraflow/db'

export interface CreatedProject {
  name: string
  slug: string
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

export async function createProject(pg: Pool, name: string): Promise<CreatedProject> {
  const slug = slugify(name)
  const writeKey = `wk_${randomBytes(16).toString('hex')}`
  const serverKey = `sk_${randomBytes(24).toString('hex')}`

  try {
    await pg.query(
      'INSERT INTO projects (name, slug, write_key, server_key_hash) VALUES ($1, $2, $3, $4)',
      [name, slug, writeKey, createHash('sha256').update(serverKey).digest('hex')],
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProjectExistsError(slug)
    throw err
  }

  return { name, slug, writeKey, serverKey }
}
