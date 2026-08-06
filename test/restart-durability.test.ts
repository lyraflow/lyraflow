import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createChClient } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', 'docker-compose.ci.yml', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow',
})

const BASE = 'http://localhost:3000'
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

describe('restart durability', () => {
  it('loses no accepted event across a graceful restart under continuous ingest', async () => {
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
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36',
          },
          body: JSON.stringify({ message_id: id, anonymous_id: 'durability', event: 'ping' }),
        }).catch(() => null)

        // Only events the server ACCEPTED are covered by the durability
        // guarantee. A 503 during the drain window is correct behaviour.
        if (res?.status === 202) sent.push(id)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    await new Promise((r) => setTimeout(r, 3000))
    const restartStartedAt = Date.now()
    compose('restart', 'lyraflow')
    const restartMs = Date.now() - restartStartedAt
    await waitReady()
    await new Promise((r) => setTimeout(r, 3000))

    // A working drain finishes in about a second. `docker compose restart`
    // only returns once the container is stopped and started again, so if
    // the shutdown handler were missing or broken, the container would
    // ignore SIGTERM (see docker-compose.ci.yml's `init: true` comment) and
    // this call would block for the full `stop_grace_period` (30s) waiting
    // for SIGKILL — a symptom distinct from, and in addition to, event loss.
    expect(restartMs).toBeLessThan(15_000)

    stop = true
    await sender
    await new Promise((r) => setTimeout(r, 3000))

    const rs = await ch.query({
      query: "SELECT count(DISTINCT event_id) AS c FROM events WHERE event_name = 'ping'",
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()

    expect(sent.length).toBeGreaterThan(50)
    expect(Number(rows[0]?.c)).toBe(sent.length)
  }, 300_000)
})
