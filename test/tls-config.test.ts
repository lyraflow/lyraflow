import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every assertion here is against `docker compose config`, which resolves
// profiles and interpolation without starting anything. That is deliberate:
// these are the guards that must hold for EXISTING installs, and a guard that
// takes three minutes to run is a guard that gets skipped.
//
// `--env-file` with an explicit file rather than the repo's own .env: a
// developer machine has a real .env with a domain in it, and the default
// lookup would make this suite pass or fail depending on whose laptop it ran
// on.
const composeConfig = (envFileContents: string, args: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lyraflow-tls-cfg-'))
  const envFile = join(dir, 'env')
  writeFileSync(envFile, envFileContents)
  try {
    return execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        envFile,
        '--project-directory',
        '.',
        '-f',
        'docker-compose.yml',
        ...args,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const services = (envFileContents: string): string[] =>
  composeConfig(envFileContents, ['config', '--services'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()

// Passwords are required for interpolation to resolve; their values are
// irrelevant to every assertion in this file.
const BASE = 'POSTGRES_PASSWORD=x\nCLICKHOUSE_PASSWORD=y\n'

describe('the tls profile', () => {
  it('is inactive when no domain is configured, so existing installs are untouched', () => {
    expect(services(BASE)).toEqual(['clickhouse', 'lyraflow', 'postgres'])
  })

  it('brings up caddy when COMPOSE_PROFILES selects it', () => {
    expect(services(`${BASE}COMPOSE_PROFILES=tls\n`)).toEqual([
      'caddy',
      'clickhouse',
      'lyraflow',
      'postgres',
    ])
  })
})

describe('where the app is published', () => {
  it('is reachable from anywhere by default, as it is today', () => {
    const cfg = composeConfig(BASE, ['config'])
    expect(cfg).toContain('published: "3000"')
    expect(cfg).not.toContain('host_ip: 127.0.0.1')
  })

  it('is loopback-only once LYRAFLOW_PUBLISH says so', () => {
    const cfg = composeConfig(`${BASE}LYRAFLOW_PUBLISH=127.0.0.1:3000:3000\n`, ['config'])
    expect(cfg).toContain('host_ip: 127.0.0.1')
  })
})
