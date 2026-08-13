import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
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
//
// `ss` is stubbed too, but not to a constant: a stub that always reports "no
// listener" makes the port check unreachable, which is exactly how a re-run
// that refused to install on its own Caddy stayed green through a whole
// branch. `ssListening` picks which answer this case gets.
interface InstallOpts {
  env?: Record<string, string>
  existingEnv?: string
  // Ports the `ss` stub should claim are already bound. Default: none.
  ssListening?: number[]
}

interface InstallResult {
  status: number
  stdout: string
  stderr: string
  // undefined when the script exited before creating .env.
  env: string | undefined
}

const runInstallRaw = (args: string[], opts: InstallOpts = {}): InstallResult => {
  const dir = mkdtempSync(join(tmpdir(), 'lyraflow-install-'))
  cpSync('install.sh', join(dir, 'install.sh'))
  chmodSync(join(dir, 'install.sh'), 0o755)

  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const cmd of ['docker', 'curl']) {
    writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, cmd), 0o755)
  }

  // install.sh calls `ss -ltnH "sport = :$port"` and treats any output at all
  // as "taken". The stub reproduces that shape: one LISTEN line for a port
  // this case says is bound, nothing for any other.
  const listening = opts.ssListening ?? []
  writeFileSync(
    join(bin, 'ss'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in',
      ...listening.map(
        (port) =>
          `    *":${port}") echo "LISTEN 0      4096         0.0.0.0:${port}        0.0.0.0:*" ;;`,
      ),
      '  esac',
      'done',
      'exit 0',
    ].join('\n'),
  )
  chmodSync(join(bin, 'ss'), 0o755)

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

  const result = spawnSync('./install.sh', args, {
    cwd: dir,
    encoding: 'utf8',
    // stdio 'pipe' also means stdin is not a TTY, which is what proves the
    // prompt is skipped for scripted installs rather than hanging forever.
    stdio: 'pipe',
    env: { ...inherited, PATH: `${bin}:${process.env.PATH}`, ...opts.env },
  })

  const envPath = join(dir, '.env')
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    env: existsSync(envPath) ? readFileSync(envPath, 'utf8') : undefined,
  }
}

// The success path. Fails loudly rather than returning a status nobody
// asserted on, so a case that starts exiting 1 cannot pass by accident.
const runInstall = (args: string[], opts: InstallOpts = {}): { env: string; stdout: string } => {
  const r = runInstallRaw(args, opts)
  if (r.status !== 0) throw new Error(`install.sh exited ${r.status}\n${r.stdout}\n${r.stderr}`)
  if (r.env === undefined) throw new Error('install.sh exited 0 without writing .env')
  return { env: r.env, stdout: r.stdout }
}

// A .env in the shape install.sh leaves behind for a TLS install of `domain`.
const tlsEnv = (domain: string): string =>
  [
    'POSTGRES_PASSWORD=keepme',
    'CLICKHOUSE_PASSWORD=alsokeepme',
    `LYRAFLOW_DOMAIN=${domain}`,
    'COMPOSE_PROFILES=tls',
    'LYRAFLOW_PUBLISH=127.0.0.1:3000:3000',
    '',
  ].join('\n')

describe('local install', () => {
  it('writes both passwords and nothing about TLS', () => {
    const { env } = runInstall([])
    expect(env).toMatch(/^POSTGRES_PASSWORD=.+$/m)
    expect(env).toMatch(/^CLICKHOUSE_PASSWORD=.+$/m)
    expect(env).not.toContain('LYRAFLOW_DOMAIN')
    expect(env).not.toContain('COMPOSE_PROFILES')
    expect(env).not.toContain('LYRAFLOW_PUBLISH')
  })

  it('tells the operator to use localhost, because that is what it published', () => {
    const { stdout } = runInstall([])
    expect(stdout).toContain('LYRAFLOW_HOST=http://localhost:3000')
    expect(stdout).not.toContain('https://')
  })
})

describe('domain install', () => {
  it('accepts the domain as an argument', () => {
    const { env } = runInstall(['analytics.example.com'])
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
    expect(env).toContain('COMPOSE_PROFILES=tls')
    expect(env).toContain('LYRAFLOW_PUBLISH=127.0.0.1:3000:3000')
  })

  it('accepts the domain from the environment, for scripted installs', () => {
    const { env } = runInstall([], { env: { LYRAFLOW_DOMAIN: 'analytics.example.com' } })
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
    expect(env).toContain('COMPOSE_PROFILES=tls')
  })
})

describe('an existing .env', () => {
  it('keeps its passwords verbatim when a domain is added later', () => {
    const existing = 'POSTGRES_PASSWORD=keepme\nCLICKHOUSE_PASSWORD=alsokeepme\n'
    const { env } = runInstall(['analytics.example.com'], { existingEnv: existing })
    expect(env).toContain('POSTGRES_PASSWORD=keepme')
    expect(env).toContain('CLICKHOUSE_PASSWORD=alsokeepme')
    expect(env).toContain('LYRAFLOW_DOMAIN=analytics.example.com')
  })

  it('does not duplicate or overwrite a domain it already has', () => {
    const existing =
      'POSTGRES_PASSWORD=keepme\nCLICKHOUSE_PASSWORD=alsokeepme\nLYRAFLOW_DOMAIN=old.example.com\n'
    const { env } = runInstall(['new.example.com'], { existingEnv: existing })
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

// `./install.sh <domain>` is the only command the README gives for enabling
// TLS, so it is also the command an operator re-runs to pick up a new image.
// On a stack that is already serving that domain, the thing holding port 80 is
// this install's own Caddy -- and refusing to install because of it made the
// documented command a one-shot.
describe('re-running on an install that already serves this domain', () => {
  it('proceeds even though something is listening on 80 and 443', () => {
    const { env, stdout } = runInstall(['analytics.example.com'], {
      existingEnv: tlsEnv('analytics.example.com'),
      ssListening: [80, 443],
    })
    // Got past the port check and all the way to the end.
    expect(stdout).toContain('Lyraflow is running.')
    // ...without touching a single value the running stack depends on.
    expect(env).toBe(tlsEnv('analytics.example.com'))
  })
})

// The other half of the pair. Deleting the port check entirely would make the
// case above pass; these are what stop that, and they are the case the check
// was written for -- some other service already holding the port.
describe('the port check still fires', () => {
  it('for a first install, where the listener cannot be ours', () => {
    const r = runInstallRaw(['analytics.example.com'], { ssListening: [80] })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Port 80 is already in use')
    // Refused before writing anything, which is the point of checking first.
    expect(r.env).toBeUndefined()
  })

  it('for a domain other than the one .env already carries', () => {
    const r = runInstallRaw(['new.example.com'], {
      existingEnv: tlsEnv('old.example.com'),
      ssListening: [80],
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Port 80 is already in use')
  })

  it('for 443 alone, when only 443 is taken', () => {
    const r = runInstallRaw(['analytics.example.com'], { ssListening: [443] })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Port 443 is already in use')
  })
})

// What the operator is told to paste. On a TLS install this has to name the
// domain even when the run that printed it was given no argument -- the
// interactive prompt invites exactly that ("leave blank"), and so did the
// port-check error message. A snippet built from http://localhost:3000 is
// blocked as active mixed content on the https page it was meant for, which
// is the failure the HTTPS support exists to prevent.
describe('the host it tells the operator to use', () => {
  it('comes from .env, not from this invocation, when no domain is given', () => {
    const { stdout } = runInstall([], { existingEnv: tlsEnv('analytics.example.com') })
    expect(stdout).toContain('LYRAFLOW_HOST=https://analytics.example.com')
    expect(stdout).not.toContain('http://localhost:3000')
  })

  it('comes from .env even when this invocation names a different domain', () => {
    // add_setting keeps the .env value, so the stack still serves the old
    // name; printing the new one would describe a stack that does not exist.
    const { stdout } = runInstall(['new.example.com'], {
      existingEnv: tlsEnv('old.example.com'),
      ssListening: [],
    })
    expect(stdout).toContain('LYRAFLOW_HOST=https://old.example.com')
    expect(stdout).toContain('Checking https://old.example.com/ready')
    // Every URL it prints names the served domain. The run still echoes the
    // requested one in its progress lines -- "Configuring TLS for
    // new.example.com...", immediately followed by "LYRAFLOW_DOMAIN is
    // already set in .env — keeping it." -- and that pair is honest.
    expect(stdout).not.toMatch(/\bhttps?:\/\/\S*new\.example\.com/)
  })

  it('comes from this invocation on a first TLS install, where .env has none yet', () => {
    const { stdout } = runInstall(['analytics.example.com'])
    expect(stdout).toContain('LYRAFLOW_HOST=https://analytics.example.com')
  })
})
