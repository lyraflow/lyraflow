import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createChClient } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Imported straight from the built package rather than duplicated here: this
// is the exact SQL expression the (not-yet-public) segment/query layer will
// use to resolve identity through the ClickHouse dictionaries, and a copy
// pasted into this file could drift from it silently. `resolve.ts` has no
// runtime imports of its own (see its source), so pulling it in this way
// carries none of packages/server/src/index.ts's side effects (env reads,
// listen()) that importing "@lyraflow/server" itself would trigger.
import { resolvedPersonExpr } from '../packages/server/dist/identity/resolve.js'

const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', 'docker-compose.ci.yml', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

// The database this stack's docker-compose.ci.yml configures, named once so
// the client connection and resolvedPersonExpr's dictionary qualification
// cannot drift apart — the exact mismatch resolvedPersonExpr's now-required
// `database` parameter exists to make impossible.
const CH_DATABASE = 'lyraflow'
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DATABASE,
})

const BASE = 'http://localhost:3000'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36'
// Same format ingest/row.ts's chDateTime produces — ClickHouse's DateTime64
// string literals — kept local rather than imported so this file's only
// cross-package reach-in is the one SQL expression above that is actually
// load-bearing for the assertion (see resolvedPersonExpr's comment).
const chDateTime = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '')

let writeKey: string

async function waitReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/ready`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Lyraflow did not become ready in time')
}

beforeAll(async () => {
  // Volumes now survive `down`, so a previous run that died before afterAll
  // would otherwise leave a 'Durability' project behind — create-project would
  // exit non-zero on the duplicate slug and the write key would never be
  // parsed. Start from nothing every time.
  compose('down', '-v')
  compose('up', '-d', '--wait')
  await waitReady()
  const out = compose(
    'exec',
    '-T',
    'lyraflow',
    'node',
    'packages/cli/dist/index.js',
    'create-project',
    'Durability',
  )
  writeKey = /wk_[a-f0-9]+/.exec(out)?.[0] as string
  expect(writeKey).toBeTruthy()
}, 300_000)

afterAll(async () => {
  await ch.close()
  compose('down', '-v')
})

/**
 * `restartStack` performs the *documented* upgrade sequence, not `docker
 * compose restart lyraflow`. README.md tells operators to run `pull && down &&
 * up -d`, and the two are not the same command: `down` stops ClickHouse and
 * Postgres as well, while the drain's final INSERT needs ClickHouse alive. That
 * it works rests on Compose stopping services in reverse dependency order —
 * an inference the branch's central durability claim should not rest on
 * untested. Exercising the real command is the only way to know.
 */
function restartStack(): void {
  compose('down')
  compose('up', '-d', '--wait')
}

const ANON_ID = 'durability'
const PERSON_ID = 'durability-person'

describe('restart durability', () => {
  it('loses no accepted event across the documented down/up upgrade under continuous ingest, and identity bindings made before the restart still resolve afterwards', async () => {
    const sent: string[] = []
    let stop = false

    const sender = (async () => {
      while (!stop) {
        const id = randomUUID()
        const res = await fetch(`${BASE}/v1/track`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-lyraflow-write-key': writeKey,
            'user-agent': UA,
          },
          body: JSON.stringify({ message_id: id, anonymous_id: ANON_ID, event: 'ping' }),
        }).catch(() => null)

        // Only events the server ACCEPTED are covered by the durability
        // guarantee. A 503 during the drain window is correct behaviour.
        if (res?.status === 202) sent.push(id)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    // Set only once the identify() below is actually accepted — read by the
    // identity assertion after the restart to select just the pings that
    // landed strictly before the bind existed.
    let identifiedAt: Date | undefined

    // Everything that can throw ahead of `stop = true` (waitReady()'s
    // timeout, the restartMs assertion) must not skip stopping the sender:
    // without this try/finally, a thrown assertion leaves `stop` false
    // forever, and the sender's `while (!stop)` loop — with its 20ms
    // setTimeout — keeps running orphaned in the vitest worker after the
    // test has already failed, risking a hung/force-killed worker in
    // exactly the regression case (a hung container) this test exists to
    // catch fastest.
    try {
      // Give the sender a head start so some 'ping' events are already
      // accepted, under ANON_ID, before the device is ever bound to a
      // person — these are the events the assertion below cares about.
      await new Promise((r) => setTimeout(r, 1000))

      const identifyRes = await fetch(`${BASE}/v1/identify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lyraflow-write-key': writeKey,
          'user-agent': UA,
        },
        body: JSON.stringify({
          message_id: randomUUID(),
          anonymous_id: ANON_ID,
          user_id: PERSON_ID,
        }),
      })
      expect(identifyRes.status).toBe(202)
      identifiedAt = new Date()

      // Same total pre-restart window as before this change (1000ms + 2000ms
      // = 3000ms), just split around the identify() call above.
      await new Promise((r) => setTimeout(r, 2000))

      const restartStartedAt = Date.now()
      restartStack()
      const restartMs = Date.now() - restartStartedAt
      await waitReady()
      await new Promise((r) => setTimeout(r, 3000))

      // A working drain finishes in about a second. `docker compose down` only
      // returns once every container has stopped, so if the shutdown handler
      // were missing or broken, the container would ignore SIGTERM (see
      // docker-compose.ci.yml's `init: true` comment) and this would block for
      // the full `stop_grace_period` (30s) waiting for SIGKILL — a symptom
      // distinct from, and in addition to, event loss. The budget covers
      // `up -d --wait` too, which must re-clear every healthcheck.
      expect(restartMs).toBeLessThan(90_000)
    } finally {
      stop = true
      await sender
    }

    await new Promise((r) => setTimeout(r, 3000))

    const rs = await ch.query({
      query: "SELECT count(DISTINCT event_id) AS c FROM events WHERE event_name = 'ping'",
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()

    expect(sent.length).toBeGreaterThan(50)
    expect(Number(rows[0]?.c)).toBe(sent.length)

    // The identity assertion: bindings written to Postgres before the
    // restart (Task 3), the derived-range view they read through (Task 1),
    // and the ClickHouse dictionaries built from that view (Task 5) all
    // survive the down/up upgrade together. The dictionaries are created at
    // boot — not by a migration — specifically so their DDL never needs to
    // carry the Postgres password into a committed file (see
    // ensureIdentityDictionaries's docstring); that also makes them the one
    // piece of identity resolution with no migration ledger forcing it back
    // into existence, so this is the check that would actually catch it
    // quietly going missing after an upgrade. resolvedPersonExpr is the
    // exact two-stage dictGetOrDefault expression the query layer resolves
    // identity through — a FAILED or still-empty dictionary answers every
    // lookup with the caller's own anonymous_id as its default (see
    // dictionaries.ts), so this assertion fails loudly instead of quietly
    // passing against degraded identity resolution.
    if (!identifiedAt) throw new Error('identify() was never confirmed accepted')
    const resolvedRs = await ch.query({
      query: `
        SELECT DISTINCT ${resolvedPersonExpr({ database: CH_DATABASE })} AS resolved
        FROM events
        WHERE event_name = 'ping' AND anonymous_id = '${ANON_ID}' AND timestamp < '${chDateTime(identifiedAt)}'
      `,
      format: 'JSONEachRow',
    })
    const resolvedRows = await resolvedRs.json<{ resolved: string }>()

    // Non-empty first: an empty result here would make the `.every(...)`
    // check below vacuously true, silently passing even if the head start
    // above somehow produced zero pre-identify pings.
    expect(resolvedRows.length).toBeGreaterThan(0)
    expect(resolvedRows.every((r) => r.resolved === PERSON_ID)).toBe(true)
  }, 300_000)
})
