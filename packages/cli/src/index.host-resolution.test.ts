/**
 * Drives the BUILT CLI as a real subprocess to prove `resolveHost` (index.ts)
 * is actually wired into `main()`'s dispatch — not just correct in
 * isolation. `index.test.ts`'s `resolveHost`/`hostFromDomain` unit tests
 * cover every precedence branch as a pure function; what they cannot show is
 * whether `main()` really calls it and really uses what it returns to build
 * `Client`. Two ways that gap could open even with a fully-correct
 * `resolveHost`: a copy-paste of the old `extractOverride(...) ||
 * process.env.LYRAFLOW_HOST` left behind at the dispatch site, or the new
 * call wired to the wrong variable — both would leave every unit test green.
 *
 * No Postgres/ClickHouse needed for any test here. The first test fails
 * before any request is built at all (the missing-config usage error). The
 * rest use a small in-process HTTP stub for `/v1/project` (and the two
 * informational endpoints) standing in for the real server, plus one
 * address nothing is listening on to fail FAST and deterministically at the
 * network layer rather than actually reaching anything — the point in every
 * case is which host was DIALED, not what a real server would have
 * answered.
 *
 * Requires `pnpm build` to have run first (this repo's own convention — see
 * the root CLAUDE.md) so `dist/index.js` exists.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

/** An address nothing is listening on — bound, then immediately closed —
 * so a connection attempt against it is refused at the TCP layer straight
 * away instead of hanging or timing out. `createServer` rather than a fixed
 * port: picking one from the OS (port 0) means this can never collide with
 * something a parallel test run already bound. */
function unusedAddress(): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        srv.close()
        reject(new Error('unusedAddress: no usable address'))
        return
      }
      const { port } = address
      srv.close(() => resolve(`127.0.0.1:${port}`))
    })
  })
}

/** A stub standing in for the real server's three `snippet` requests —
 * enough for the command to complete successfully (exit 0), which is the
 * whole point: reaching a real 200 proves the CLI actually dialed THIS
 * server, not merely that it built some URL and gave up. */
function startProjectStub(): Promise<{ server: Server; host: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/v1/project')) {
      res.end(JSON.stringify({ name: 'stub', slug: 'stub', write_key: 'wk_stub' }))
    } else if (req.url?.startsWith('/v1/schema/events')) {
      res.end(JSON.stringify({ events: [] }))
    } else if (req.url?.startsWith('/v1/events/stats')) {
      res.end(JSON.stringify({ buckets: [] }))
    } else {
      res.end('{}')
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('startProjectStub: no usable address'))
        return
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

function collect(stream: Readable): { text: () => string } {
  let text = ''
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  return { text: () => text }
}

let openChild: ChildProcessByStdio<null, Readable, Readable> | undefined
let openServer: Server | undefined

afterEach(() => {
  openChild?.kill()
  openChild = undefined
  openServer?.close()
  openServer = undefined
})

describe('snippet host resolution against a real subprocess (issue #61)', () => {
  it('with none of --host, LYRAFLOW_HOST or LYRAFLOW_DOMAIN set, keeps todays exact usage error', async () => {
    const env = { ...process.env }
    env.LYRAFLOW_HOST = undefined
    env.LYRAFLOW_DOMAIN = undefined
    env.LYRAFLOW_SERVER_KEY = undefined

    const child = spawn(process.execPath, [CLI_ENTRY, 'snippet', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child
    const stderr = collect(child.stderr)
    const exitCode = await waitForExit(child)

    expect(exitCode).toBe(2)
    expect(JSON.parse(stderr.text().trim())).toEqual({
      error: 'LYRAFLOW_HOST and LYRAFLOW_SERVER_KEY must be set (or pass --host/--server-key)',
      code: 'usage_error',
    })
  }, 15000)

  it('LYRAFLOW_DOMAIN alone (no --host, no LYRAFLOW_HOST) is actually dialed, not just accepted as "configured"', async () => {
    // If main() still ignored the derived host, this would hit the SAME
    // exit-2 usage error as the test above (host "not set"). Getting exit 1
    // with a network-layer failure instead proves a real connection attempt
    // was made — against the https://<domain> address `hostFromDomain`
    // derives, since nothing is listening there.
    const address = await unusedAddress()
    const env = { ...process.env }
    env.LYRAFLOW_HOST = undefined
    env.LYRAFLOW_DOMAIN = address
    env.LYRAFLOW_SERVER_KEY = 'sk_test'

    const child = spawn(process.execPath, [CLI_ENTRY, 'snippet', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child
    const stderr = collect(child.stderr)
    const exitCode = await waitForExit(child)

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr.text().trim()).code).toBe('no_response')
  }, 15000)

  it('an explicit --host wins over LYRAFLOW_DOMAIN, at the real dispatch site', async () => {
    // LYRAFLOW_DOMAIN points at an address nothing answers; --host points
    // at a real stub. Only reaching the stub (exit 0, its write key printed)
    // proves --host — not LYRAFLOW_DOMAIN — was the address actually dialed.
    const { server, host: flagHost } = await startProjectStub()
    openServer = server
    const domainAddress = await unusedAddress()
    const env = { ...process.env }
    env.LYRAFLOW_HOST = undefined
    env.LYRAFLOW_DOMAIN = domainAddress
    env.LYRAFLOW_SERVER_KEY = 'sk_test'

    const child = spawn(process.execPath, [CLI_ENTRY, 'snippet', '--host', flagHost, '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    const exitCode = await waitForExit(child)

    expect(exitCode, `stderr: ${stderr.text()}`).toBe(0)
    const parsed = JSON.parse(stdout.text().trim())
    expect(parsed.host).toBe(flagHost)
    expect(parsed.write_key).toBe('wk_stub')
  }, 15000)

  it('LYRAFLOW_HOST wins over LYRAFLOW_DOMAIN, at the real dispatch site', async () => {
    // Same shape as the --host test above, one tier down: LYRAFLOW_HOST
    // points at the real stub, LYRAFLOW_DOMAIN at an address nothing
    // answers. Only reaching the stub proves LYRAFLOW_HOST won.
    const { server, host: envHost } = await startProjectStub()
    openServer = server
    const domainAddress = await unusedAddress()
    const env = { ...process.env }
    env.LYRAFLOW_HOST = envHost
    env.LYRAFLOW_DOMAIN = domainAddress
    env.LYRAFLOW_SERVER_KEY = 'sk_test'

    const child = spawn(process.execPath, [CLI_ENTRY, 'snippet', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    openChild = child
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    const exitCode = await waitForExit(child)

    expect(exitCode, `stderr: ${stderr.text()}`).toBe(0)
    const parsed = JSON.parse(stdout.text().trim())
    expect(parsed.host).toBe(envHost)
    expect(parsed.write_key).toBe('wk_stub')
  }, 15000)
})
