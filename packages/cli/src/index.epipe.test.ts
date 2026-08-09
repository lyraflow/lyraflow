/**
 * Drives the BUILT CLI as a real subprocess against a real, OS-level
 * closed pipe — not a throwing fake. This is the only way to reproduce
 * `process.stdout`'s real EPIPE failure mode: it is asynchronous (an
 * `'error'` event on the underlying socket, arriving after `write()` has
 * already returned), so nothing inside this process's own call stack can
 * simulate it by having a function throw. See index.ts's
 * `installStdoutEpipeGuard` docstring for the full reasoning, and
 * events.ts's/stats.ts's `isEpipe` docstrings for why their own
 * synchronous guards — tested separately, with a throwing fake, in
 * events.test.ts/stats.test.ts — are real but insufficient on their own.
 *
 * Requires `pnpm build` to have run first (this repo's own convention —
 * see the root CLAUDE.md) so `dist/index.js` exists.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

const FAKE_EVENT = {
  event_id: 'e1',
  timestamp: '2026-08-08T11:59:00.000Z',
  event_name: 'page_view',
  anonymous_id: 'anon-1',
  user_id: '',
  properties: {},
  properties_num: {},
  url: '',
  path: '',
  referrer: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_term: '',
  utm_content: '',
  device_type: '',
  os: '',
  browser: '',
  country: '',
  region: '',
  city: '',
}

function startFakeServer(): Promise<{ server: Server; host: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ events: [FAKE_EVENT], next_cursor: null }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('fake server has no usable address')
      }
      resolve({ server, host: `http://127.0.0.1:${address.port}` })
    })
  })
}

function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
  })
}

let openChild: ChildProcessByStdio<null, Readable, Readable> | undefined
let openServer: Server | undefined

afterEach(() => {
  openChild?.kill()
  openChild = undefined
  openServer?.close()
  openServer = undefined
})

describe('EPIPE against a real subprocess and a real closed pipe', () => {
  it('exits 0 instead of crashing when the reader closes the pipe before the child ever writes (a real `| head`-shaped situation)', async () => {
    const { server, host } = await startFakeServer()
    openServer = server

    const child = spawn(process.execPath, [CLI_ENTRY, 'events', '--json'], {
      env: { ...process.env, LYRAFLOW_HOST: host, LYRAFLOW_SERVER_KEY: 'test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child
    // Never listen for 'error' — an unhandled 'error' on a destroyed
    // stream would otherwise crash this test process, which is not what
    // is under test here.
    child.stdout.on('error', () => {})

    // Close our end of the pipe immediately, before the child can
    // plausibly have written anything yet — the closest analogue to
    // `command | true`. Deterministic: it does not depend on payload size
    // or read timing, unlike destroying only after a 'data' event.
    child.stdout.destroy()

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const exitCode = await waitForExit(child)

    expect(exitCode).toBe(0)
    expect(stderr).not.toMatch(/Unhandled|Emitted 'error' event|at afterWriteDispatched/)
  }, 15000)

  it('a genuine, unrelated failure still exits non-zero with the EPIPE guard installed', async () => {
    // Confirms the global process.stdout 'error' handler does not swallow
    // real failures — only ever changes behaviour for EPIPE specifically.
    // `migrate` with no Postgres/ClickHouse env vars configured throws
    // synchronously and immediately, no server needed.
    const env = { ...process.env }
    env.LYRAFLOW_POSTGRES_URL = undefined
    env.LYRAFLOW_CLICKHOUSE_URL = undefined
    env.LYRAFLOW_CLICKHOUSE_USER = undefined
    env.LYRAFLOW_CLICKHOUSE_PASSWORD = undefined
    env.LYRAFLOW_CLICKHOUSE_DB = undefined

    const child = spawn(process.execPath, [CLI_ENTRY, 'migrate'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child

    const exitCode = await waitForExit(child)

    expect(exitCode).not.toBe(0)
  }, 15000)

  it('the missing-config usage error honours --json in argv, at the dispatch layer (not only inside events.ts/stats.ts)', async () => {
    const env = { ...process.env }
    env.LYRAFLOW_HOST = undefined
    env.LYRAFLOW_SERVER_KEY = undefined

    const child = spawn(process.execPath, [CLI_ENTRY, 'events', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exitCode = await waitForExit(child)

    expect(exitCode).toBe(2)
    expect(() => JSON.parse(stderr.trim())).not.toThrow()
  }, 15000)
})
