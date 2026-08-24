import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every environment variable `loadConfig` reads has to be either passed to the
 * container by the shipped compose file, or deliberately not passed.
 *
 * WHAT WENT WRONG (#195). `LYRAFLOW_ALLOWED_ORIGINS` was read by `loadConfig`,
 * documented in the README as a thing you set "on the server", and named
 * nowhere in `docker-compose.yml`. Compose passes a container only the
 * variables a compose file's `environment:` block names — `.env` is for
 * substitution *inside* the compose file, not injection into the container —
 * so the documented instruction did nothing. An operator set it, restarted,
 * got no error, and had an install that still answered the CORS preflight for
 * every origin on the internet.
 *
 * The direction of that failure is what makes it worth a test rather than a
 * fix. Unset means "allow every origin", so the variable not arriving is
 * indistinguishable from the variable arriving and working, right up until
 * somebody exploits the difference. Nothing is logged, rejected or counted at
 * request time by design (a blocked preflight is answered by omitting a header,
 * not by refusing), so there is no runtime signal to notice either.
 *
 * WHY AN ALLOW-LIST, not "everything must be passed". Most of what `loadConfig`
 * reads is a tuning knob with a sensible default, where not arriving means the
 * default stayed in force — visible in behaviour, harmless, and reasonable to
 * leave off a compose file that is meant to stay readable. The distinction that
 * matters is not "is it passed" but "did somebody decide". This is the same
 * shape as `compose-flags.test.ts`'s FLAG_SINCE, and for the same reason: a new
 * variable appearing on neither list is exactly the failure mode, and adding
 * one should take a decision rather than an oversight.
 */

/**
 * Read by `loadConfig`, deliberately NOT named in `docker-compose.yml`, with
 * the reason it is safe to leave off.
 *
 * The bar for adding an entry here: not arriving must fail in a direction an
 * operator can see. If the quiet outcome is the permissive or destructive one,
 * it belongs in the compose file instead.
 */
const NOT_PASSED_THROUGH: Record<string, string> = {
  // Buffer and flush tuning. Not arriving leaves the documented defaults in
  // force; the effect is throughput, which is measurable from /metrics.
  LYRAFLOW_BUFFER_MAX_ROWS: 'tuning knob, default is safe and observable',
  LYRAFLOW_FLUSH_INTERVAL_MS: 'tuning knob, default is safe and observable',
  LYRAFLOW_FLUSH_ROWS: 'tuning knob, default is safe and observable',
  LYRAFLOW_PROJECT_CACHE_TTL_MS: 'tuning knob, default is safe and observable',
  // Named in a compose COMMENT (beside stop_grace_period) but not in the
  // environment block, which is how it reads as passed-through at a glance.
  // Safe to leave off in the one direction that matters: not arriving means
  // the 25s default stays, which is already below the 30s stop_grace_period,
  // and loadConfig refuses to boot on any value that is not. An operator
  // raising it who does not get it stays protected from SIGKILL mid-drain --
  // the failure is a shorter drain, not a silently voided guarantee.
  LYRAFLOW_DRAIN_DEADLINE_MS:
    'default 25s already satisfies the stop_grace_period invariant loadConfig enforces',
  // Purge scheduling. Not arriving means purges run on the default cadence --
  // slower or faster, never skipped, and the purge itself logs.
  LYRAFLOW_PURGE_INTERVAL_MS: 'purge cadence, default is safe',
  LYRAFLOW_PURGE_LEASE_MS: 'purge cadence, default is safe',
  LYRAFLOW_PURGE_MAX_ATTEMPTS: 'purge cadence, default is safe',
  LYRAFLOW_PROJECT_PURGE_INTERVAL_MS: 'purge cadence, default is safe',
  LYRAFLOW_PROJECT_PURGE_LEASE_MS: 'purge cadence, default is safe',
  LYRAFLOW_PROJECT_PURGE_MAX_ATTEMPTS: 'purge cadence, default is safe',
  // Retention. Not arriving means retention RUNS, which is the shipped
  // default and what the README documents. The README's upgrade section tells
  // an operator to put it straight in the compose file for exactly this
  // reason, and index.ts logs once at startup when it is off -- so the quiet
  // outcome here is the documented one, and the loud choice is visible.
  LYRAFLOW_RETENTION_ENABLED:
    'default (enabled) is the documented behaviour; startup logs the off case',
  LYRAFLOW_RETENTION_INTERVAL_MS: 'tuning knob, default is safe',
}

const compose = readFileSync('docker-compose.yml', 'utf8')
const configSrc = readFileSync('packages/server/src/config.ts', 'utf8')

/**
 * Variable names `loadConfig` actually reads.
 *
 * Comments are stripped first, deliberately. `config.ts` is heavily commented
 * and names variables in prose constantly (including ones it does not read,
 * like `LYRAFLOW_RETENTION_ENABLED=FALSE` as an example of a rejected
 * spelling). Collecting those would make this audit about the prose rather
 * than the code.
 */
function readByConfig(): string[] {
  const code = configSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...new Set([...code.matchAll(/\bLYRAFLOW_[A-Z0-9_]+/g)].map((m) => m[0]))].sort()
}

/**
 * The names in the `lyraflow` service's `environment:` block.
 *
 * Text-parsed rather than YAML-parsed: this repo has no YAML dependency, and
 * the other compose tests read the file the same way. Scoped to that one
 * service on purpose -- `LYRAFLOW_DOMAIN` also appears in caddy's block and
 * `LYRAFLOW_PUBLISH` in `ports:`, and neither of those reaches the server
 * process, so a whole-file `includes()` would pass for a variable the server
 * never sees.
 */
function passedToServer(): string[] {
  const lines = compose.split('\n')
  const serviceAt = lines.findIndex((l) => /^ {2}lyraflow:\s*$/.test(l))
  expect(serviceAt, 'no `lyraflow:` service in docker-compose.yml').toBeGreaterThanOrEqual(0)

  const envAt = lines.findIndex((l, i) => i > serviceAt && /^ {4}environment:\s*$/.test(l))
  expect(envAt, 'the lyraflow service has no `environment:` block').toBeGreaterThan(serviceAt)

  const out: string[] = []
  for (let i = envAt + 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '' || /^ {6}#/.test(line)) continue
    // Any key at 4-space indent or shallower ends the block.
    if (!/^ {6}/.test(line)) break
    const m = /^ {6}(LYRAFLOW_[A-Z0-9_]+):/.exec(line)
    if (m) out.push(m[1] as string)
  }
  return out.sort()
}

describe('compose passes through every variable loadConfig reads (#195)', () => {
  const read = readByConfig()
  const passed = passedToServer()

  it('finds variables on both sides, so the audit cannot pass vacuously', () => {
    // If either extractor silently stops matching -- a refactor of config.ts,
    // a reindent of the compose file -- every assertion below would go green
    // while checking nothing at all.
    expect(read.length).toBeGreaterThan(10)
    expect(passed.length).toBeGreaterThan(3)
    expect(read).toContain('LYRAFLOW_POSTGRES_URL')
    expect(passed).toContain('LYRAFLOW_POSTGRES_URL')
  })

  it('names LYRAFLOW_ALLOWED_ORIGINS in the lyraflow environment block', () => {
    // The specific regression. Kept as its own case, separate from the sweep
    // below, so the failure message names the variable that caused #195
    // instead of appearing as one entry in a list.
    expect(
      passed,
      'LYRAFLOW_ALLOWED_ORIGINS must reach the container: unset means "allow every origin", ' +
        'so a value stuck in .env leaves the install wide open with nothing to show for it',
    ).toContain('LYRAFLOW_ALLOWED_ORIGINS')
  })

  it('passes the allowlist through with a `:-` default, so a stock .env does not warn', () => {
    // Without the fallback, every `up`/`ps`/`exec` on an install whose .env
    // predates the variable warns "variable is not set" for what is the
    // documented default state.
    expect(compose).toContain('LYRAFLOW_ALLOWED_ORIGINS: ${LYRAFLOW_ALLOWED_ORIGINS:-}')
  })

  it('leaves no variable on neither list', () => {
    const unaccounted = read
      .filter((v) => !passed.includes(v))
      .filter((v) => NOT_PASSED_THROUGH[v] === undefined)
      .sort()
    expect(
      unaccounted,
      'a variable loadConfig reads that the compose file does not name: either add it to the ' +
        '`environment:` block, or add it to NOT_PASSED_THROUGH with the reason it is safe to leave off. ' +
        'If not arriving fails permissively or destructively, it is not safe to leave off.',
    ).toEqual([])
  })

  it('keeps NOT_PASSED_THROUGH honest — no stale entries', () => {
    // An entry for a variable that IS passed, or that loadConfig no longer
    // reads, is a note nobody will revisit. Both directions are stale.
    const contradicted = Object.keys(NOT_PASSED_THROUGH).filter((v) => passed.includes(v))
    expect(contradicted, 'listed as not-passed, but the compose file passes it').toEqual([])

    const orphaned = Object.keys(NOT_PASSED_THROUGH).filter((v) => !read.includes(v))
    expect(orphaned, 'listed as not-passed, but loadConfig no longer reads it').toEqual([])
  })
})
