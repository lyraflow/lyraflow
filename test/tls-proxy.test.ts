import { execFileSync } from 'node:child_process'
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

const compose = (...args: string[]): string =>
  execFileSync(
    'docker',
    ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.tls-test.yml', ...args],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      env: ENV,
    },
  )

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

  // --wait covers the app's healthcheck; Caddy declares none, and its first
  // certificate is issued after it starts. Poll until it serves.
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
