import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// install.sh is the first thing a stranger runs, and the part of it worth
// pinning is what it writes to .env -- that file holds the only copy of the
// database passwords, so an append that rewrites one leaves a stack that
// cannot reach its own database.
//
// The real script runs, with `docker` and `curl` stubbed earlier on PATH.
// Stubbing them rather than the script means these assertions are about the
// shipped code path, not about a copy of its logic.
const runInstall = (
  args: string[],
  opts: { env?: Record<string, string>; existingEnv?: string } = {},
): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lyraflow-install-'))
  cpSync('install.sh', join(dir, 'install.sh'))
  chmodSync(join(dir, 'install.sh'), 0o755)

  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const cmd of ['docker', 'curl', 'ss']) {
    writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, cmd), 0o755)
  }

  if (opts.existingEnv !== undefined) writeFileSync(join(dir, '.env'), opts.existingEnv)

  // The parent process's own environment is inherited into the child below.
  // If whatever machine runs this suite happens to export LYRAFLOW_DOMAIN,
  // COMPOSE_PROFILES or LYRAFLOW_PUBLISH, the "local install" case would
  // silently inherit it and fail for a reason that has nothing to do with
  // install.sh. Strip all three before layering the per-case env on top.
  const {
    LYRAFLOW_DOMAIN: _domain,
    COMPOSE_PROFILES: _profiles,
    LYRAFLOW_PUBLISH: _publish,
    ...inherited
  } = process.env

  execFileSync('./install.sh', args, {
    cwd: dir,
    encoding: 'utf8',
    // stdio 'pipe' also means stdin is not a TTY, which is what proves the
    // prompt is skipped for scripted installs rather than hanging forever.
    stdio: 'pipe',
    env: { ...inherited, PATH: `${bin}:${process.env.PATH}`, ...opts.env },
  })

  return readFileSync(join(dir, '.env'), 'utf8')
}

describe('local install', () => {
  it('writes both passwords and nothing about TLS', () => {
    const env = runInstall([])
    expect(env).toMatch(/^POSTGRES_PASSWORD=.+$/m)
    expect(env).toMatch(/^CLICKHOUSE_PASSWORD=.+$/m)
    expect(env).not.toContain('LYRAFLOW_DOMAIN')
    expect(env).not.toContain('COMPOSE_PROFILES')
    expect(env).not.toContain('LYRAFLOW_PUBLISH')
  })
})

describe('domain install', () => {
  it('accepts the domain as an argument', () => {
    const env = runInstall(['analytics.example.com'])
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
    expect(env).toContain('COMPOSE_PROFILES=tls')
    expect(env).toContain('LYRAFLOW_PUBLISH=127.0.0.1:3000:3000')
  })

  it('accepts the domain from the environment, for scripted installs', () => {
    const env = runInstall([], { env: { LYRAFLOW_DOMAIN: 'analytics.example.com' } })
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
    expect(env).toContain('COMPOSE_PROFILES=tls')
  })
})

describe('an existing .env', () => {
  it('keeps its passwords verbatim when a domain is added later', () => {
    const existing = 'POSTGRES_PASSWORD=keepme\nCLICKHOUSE_PASSWORD=alsokeepme\n'
    const env = runInstall(['analytics.example.com'], { existingEnv: existing })
    expect(env).toContain('POSTGRES_PASSWORD=keepme')
    expect(env).toContain('CLICKHOUSE_PASSWORD=alsokeepme')
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
  })

  it('does not duplicate or overwrite a domain it already has', () => {
    const existing =
      'POSTGRES_PASSWORD=keepme\nCLICKHOUSE_PASSWORD=alsokeepme\nLYRAFLOW_DOMAIN=old.example.com\n'
    const env = runInstall(['new.example.com'], { existingEnv: existing })
    expect(env).toContain('LYRAFLOW_DOMAIN=old.example.com')
    expect(env).not.toContain('new.example.com')
    expect(env.match(/^LYRAFLOW_DOMAIN=/gm)).toHaveLength(1)
    // The pre-seeded fixture has no COMPOSE_PROFILES line. Its presence here
    // proves the TLS-configuration block actually ran for this case -- and
    // that add_setting's already-set branch, not just "the script touched
    // nothing", is what produced the LYRAFLOW_DOMAIN assertions above.
    expect(env).toContain('COMPOSE_PROFILES=tls')
  })
})
