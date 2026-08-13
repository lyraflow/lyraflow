import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The hostname is arbitrary and never resolved: every request below pins it
// to loopback with curl's --resolve. It must match what Caddy is told, since
// Caddy serves this name and no other.
const DOMAIN = 'lyraflow.test'

const ENV = {
  ...process.env,
  LYRAFLOW_DOMAIN: DOMAIN,
  COMPOSE_PROFILES: 'tls',
  LYRAFLOW_PUBLISH: '127.0.0.1:3000:3000',
  POSTGRES_PASSWORD: 'tlstest',
  CLICKHOUSE_PASSWORD: 'tlstest',
  // Its own project name so this stack cannot collide with a dev stack's
  // containers, networks or volumes on the same machine.
  COMPOSE_PROJECT_NAME: 'lyraflow-tls-test',
}

const composeWith = (env: NodeJS.ProcessEnv, ...args: string[]): string =>
  execFileSync(
    'docker',
    ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.tls-test.yml', ...args],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
    },
  )

const compose = (...args: string[]): string => composeWith(ENV, ...args)

// -k because the certificate is from Caddy's internal CA, which this machine
// has no reason to trust. The assertion is that TLS is served and proxied at
// all, not that a public CA vouched for it.
const curl = (...args: string[]): string =>
  execFileSync(
    'curl',
    [
      '-sS',
      '-k',
      '--resolve',
      `${DOMAIN}:443:127.0.0.1`,
      '--resolve',
      `${DOMAIN}:80:127.0.0.1`,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
    },
  )

beforeAll(async () => {
  compose('down', '-v')
  // --build for the reason the other compose-driven suites pass it: the image
  // is named, so Compose reuses a stale tag indefinitely and the suite
  // quietly asserts things about an old build.
  compose('up', '-d', '--build', '--wait')

  // Caddy's healthcheck says its config loaded and the proxy is provisioned,
  // deliberately not that a certificate exists -- issuance is allowed to lag
  // without failing an install. So --wait is not the whole story here; poll
  // until it actually serves.
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      curl('-o', '/dev/null', `https://${DOMAIN}/ready`)
      return
    } catch {
      if (Date.now() > deadline) throw new Error('Caddy did not serve HTTPS within 60s')
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}, 300_000)

afterAll(() => {
  compose('down', '-v')
}, 120_000)

describe('serving through Caddy', () => {
  it('answers /ready over HTTPS', () => {
    expect(curl('-w', '%{http_code}', '-o', '/dev/null', `https://${DOMAIN}/ready`)).toBe('200')
  })

  it('serves the browser bundle, which is the thing mixed content blocks', () => {
    expect(curl('-w', '%{http_code}', '-o', '/dev/null', `https://${DOMAIN}/lyraflow.js`)).toBe(
      '200',
    )
  })

  it('redirects plain HTTP rather than serving it', () => {
    const code = curl('-w', '%{http_code}', '-o', '/dev/null', `http://${DOMAIN}/ready`)
    expect(['301', '308']).toContain(code)
  })
})

describe('the app itself', () => {
  it('is published on loopback only, so Caddy is the sole way in', () => {
    expect(compose('port', 'lyraflow', '3000').trim()).toMatch(/^127\.0\.0\.1:3000$/)
  })
})

// The one thing `docker compose config` cannot answer: does `up -d --wait`
// actually notice a Caddy that is not serving? It did not. With no
// healthcheck, --wait required only that the container had *started*, and
// `restart: unless-stopped` turned a config error into a crash-loop that
// Compose reported as "Healthy" before exiting 0 -- so install.sh printed a
// successful install over a stack serving nothing.
//
// Three cases, and each pins a different part of the fix. They were arrived
// at by mutation, not by reasoning:
//
//   - crash-loop: fails only because a healthcheck is DECLARED. Deleting the
//     healthcheck block makes this case report success again. It does not
//     pin the probe at all -- replacing the probe with `true` leaves it
//     green, because a container that keeps dying never gets to run it.
//   - running but proxying nothing: the case that pins the probe. Caddy is
//     up and serving HTTPS, so `true` would call it healthy; only a probe
//     that asks what Caddy is actually configured to do says otherwise.
//   - the shipped config: without this, both of the above would pass against
//     a healthcheck that can never succeed at all.
//
// Last in the file because they recreate the caddy container. The third
// leaves the stack serving again, and proves it.
describe('the caddy healthcheck', () => {
  // Reproduces what an operator gets by removing LYRAFLOW_DOMAIN from .env
  // and leaving COMPOSE_PROFILES=tls behind: the Caddyfile's
  // {$LYRAFLOW_DOMAIN} expands to a bare `{`, so the site block is parsed as
  // a global options block and Caddy dies on `unrecognized global option:
  // reverse_proxy`.
  const NO_DOMAIN: NodeJS.ProcessEnv = { ...ENV, LYRAFLOW_DOMAIN: '' }

  // A valid config that starts and serves, and proxies nothing. Written at
  // run time rather than committed: the bind mount has to be an absolute
  // path, since a relative one would resolve against the project directory
  // and this file does not live there.
  let noProxyDir: string
  let noProxyOverride: string
  beforeAll(() => {
    noProxyDir = mkdtempSync(join(tmpdir(), 'lyraflow-caddy-noproxy-'))
    const caddyfile = join(noProxyDir, 'Caddyfile')
    writeFileSync(caddyfile, `{$LYRAFLOW_DOMAIN} {\n\ttls internal\n\trespond "no proxy" 200\n}\n`)
    noProxyOverride = join(noProxyDir, 'compose.yml')
    // Every volume restated, for the reason docker-compose.tls-test.yml
    // gives at length: merging by target is a no-op, replacing wholesale
    // would otherwise silently drop the data volume.
    writeFileSync(
      noProxyOverride,
      [
        'services:',
        '  caddy:',
        '    volumes:',
        `      - "${caddyfile}:/etc/caddy/Caddyfile:ro"`,
        '      - "./test/fixtures/tls.d:/etc/caddy/tls.d:ro"',
        '      - "caddy-data:/data"',
        '',
      ].join('\n'),
    )
  })
  afterAll(() => {
    rmSync(noProxyDir, { recursive: true, force: true })
  })

  const upWaitCaddy = (env: NodeJS.ProcessEnv, extraFiles: string[] = []): string | undefined => {
    try {
      composeWith(env, ...extraFiles.flatMap((f) => ['-f', f]), 'up', '-d', '--wait', 'caddy')
      return undefined
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string }
      return `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }

  it('fails `up -d --wait` when Caddy cannot start at all', () => {
    const failure = upWaitCaddy(NO_DOMAIN)
    expect(failure, '`up -d --wait` succeeded against a Caddy that cannot start').toBeDefined()
    expect(failure).toContain('unhealthy')
    // The diagnosis really is the config error, not something else that
    // happened to make the probe fail.
    expect(composeWith(NO_DOMAIN, 'logs', 'caddy')).toContain('unrecognized global option')
  }, 300_000)

  it('fails `up -d --wait` when Caddy is up and serving but proxying nothing', () => {
    const failure = upWaitCaddy(ENV, [noProxyOverride])
    expect(failure, '`up -d --wait` succeeded against a Caddy that proxies nothing').toBeDefined()
    expect(failure).toContain('unhealthy')

    // Not a crash-loop this time -- which is the whole point. The container
    // is running, so a healthcheck that merely proves the process is alive
    // would call this healthy.
    const ps = composeWith(ENV, '-f', noProxyOverride, 'ps', '--format', '{{.Service}} {{.Status}}')
    expect(ps).toMatch(/caddy\s+Up[^\n]*\(unhealthy\)/)
    // And it is genuinely serving, so "serving" alone is not the line either.
    expect(curl(`https://${DOMAIN}/`)).toContain('no proxy')
  }, 300_000)

  it('passes on the shipped config, so it discriminates rather than always failing', async () => {
    expect(upWaitCaddy(ENV)).toBeUndefined()

    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        curl('-o', '/dev/null', `https://${DOMAIN}/ready`)
        return
      } catch {
        if (Date.now() > deadline) throw new Error('Caddy did not serve HTTPS again within 60s')
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }, 300_000)
})
