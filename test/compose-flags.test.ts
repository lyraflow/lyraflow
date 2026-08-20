import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Compose version floor, and the thing that keeps it honest.
 *
 * The README used to say "You need Docker and Docker Compose. Nothing else."
 * with no version named anywhere (#114). That was fine while the scripts used
 * only long-standing subcommands. It stopped being fine when `install.sh`
 * started passing a Go TEMPLATE to `docker compose ps --format`, which is not
 * a flag that has always existed in that form.
 *
 * Measured rather than assumed, from Compose's own source:
 *
 * - Before v2.21.0, `cmd/compose/ps.go` declared the flag as
 *   `"Format the output. Values: [table | json]"` and handed it to
 *   `cmd/formatter.Print`, whose `default:` branch returns
 *   `format value %q could not be parsed`. A Go template is an ERROR there,
 *   not a fallback.
 * - v2.21.0 (docker/compose#10918, "align `docker compose ps` with
 *   `docker ps`") replaced that with the docker CLI's own
 *   `formatter.NewContainerFormat`, which is what accepts `{{.Status}}`.
 * - `up --wait` is absent at v2.0.0 and present at v2.1.1.
 * - `ps --status` is present at v2.0.0.
 *
 * So the binding constraint is `ps --format` at v2.21.0, and everything else
 * in these scripts is older. That number is now in the README, and the
 * assertion at the bottom of this file is what stops it being a number
 * somebody wrote down once.
 *
 * WHY THIS IS AN ALLOW-LIST rather than a version lookup. There is no
 * machine-readable index of "which Compose release introduced this flag", so
 * nothing can compute the floor. What CAN be enforced is that every flag the
 * scripts use is one somebody deliberately checked -- the same shape as
 * `restore.sh`'s command audit, and for the same reason: a new flag appearing
 * by accident is exactly the failure mode, and it should be hard to add
 * without a decision.
 */

/**
 * Flag -> the Compose version that introduced it in the form used here.
 * `'<=2.0.0'` means "present in the first v2 release, so it cannot be the
 * binding constraint" -- these were not researched individually beyond
 * confirming they predate the floor.
 */
const FLAG_SINCE: Record<string, string> = {
  // The binding constraint. Go-template support: docker/compose#10918.
  'ps --format': '2.21.0',
  'up --wait': '2.1.1',
  'ps --status': '<=2.0.0',
  'ps --services': '<=2.0.0',
  'run --rm': '<=2.0.0',
  'run --no-deps': '<=2.0.0',
  'logs --tail': '<=2.0.0',
  '(global) --progress': '<=2.0.0',
}

/** Subcommands the scripts are allowed to invoke at all. */
const SUBCOMMANDS = new Set(['build', 'exec', 'logs', 'ps', 'pull', 'run', 'start', 'stop', 'up'])

/** Global flags that consume the token after them, so it is not a subcommand. */
const GLOBAL_FLAGS_WITH_VALUES = new Set(['--progress', '--project-name', '--file', '--env-file'])

const SCRIPTS = ['install.sh', 'backup.sh', 'backup-lib.sh', 'restore.sh']

function sources(): { file: string; text: string }[] {
  const files = [
    ...SCRIPTS,
    ...readdirSync('test')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join('test', f)),
  ]
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }))
}

/**
 * SHORT flags are deliberately not collected.
 *
 * `docker compose exec -T lyraflow sh -c '…'` continues into an INNER command
 * with flags of its own, and `-c` there belongs to `sh`, not to Compose.
 * Telling the two apart needs a real shell parser. Long flags do not have that
 * problem in practice -- no inner command in these scripts takes one -- so the
 * audit covers the half it can cover honestly rather than reporting `-c` as a
 * Compose flag.
 */
function usages(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = []
  for (const { file, text } of sources()) {
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim()
      // Prose mentions Compose constantly. A comment is not an invocation.
      if (/^(#|\/\/|\*|\/\*)/.test(trimmed)) continue
      for (const m of raw.matchAll(/docker\s+compose\b(.*)/g)) {
        // A backtick starts a markdown-ish quotation inside a test title or a
        // trailing comment; nothing past it is being executed.
        const tail = (m[1] ?? '').split('`')[0] ?? ''
        const cut = tail.split(/[|;)&]|\d?>|<'|<"| < /)[0] ?? ''
        const tokens = cut.replace(/['"]/g, ' ').split(/\s+/).filter(Boolean)

        let sub: string | null = null
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i] as string
          const flag = t.split('=')[0] as string
          if (sub === null) {
            if (t.startsWith('-')) {
              out.push({ key: `(global) ${flag}`, file })
              if (GLOBAL_FLAGS_WITH_VALUES.has(flag) && !t.includes('=')) i++
              continue
            }
            sub = t
            out.push({ key: `subcommand ${sub}`, file })
            continue
          }
          if (t.startsWith('--')) out.push({ key: `${sub} ${flag}`, file })
        }
      }
    }
  }
  return out
}

describe('the Docker Compose version floor (#114)', () => {
  const all = usages()

  it('finds invocations at all, so the audit cannot pass vacuously', () => {
    expect(all.filter((u) => u.key.startsWith('subcommand ')).length).toBeGreaterThan(10)
    // The one that sets the floor must actually be there. If it is ever
    // removed, this fails -- and that is the signal that the documented floor
    // can be LOWERED, which is a change worth noticing rather than a bug.
    expect(all.map((u) => u.key)).toContain('ps --format')
  })

  it('invokes no subcommand outside the allow-list', () => {
    const unknown = [
      ...new Set(
        all
          .filter((u) => u.key.startsWith('subcommand '))
          .map((u) => u.key.slice('subcommand '.length))
          .filter((s) => !SUBCOMMANDS.has(s)),
      ),
    ].sort()
    expect(unknown, 'a Compose subcommand nobody has checked a version floor for').toEqual([])
  })

  it('passes no long flag whose introducing version nobody has recorded', () => {
    const unknown = [
      ...new Set(
        all
          .filter((u) => !u.key.startsWith('subcommand '))
          .map((u) => u.key)
          .filter((k) => FLAG_SINCE[k] === undefined),
      ),
    ].sort()
    expect(
      unknown,
      'a Compose flag outside FLAG_SINCE: look up which release introduced it, ' +
        'add it there, and raise the README floor if it is newer',
    ).toEqual([])
  })

  it('documents exactly the highest version any flag in use requires', () => {
    // The floor is DERIVED here and compared against the README, rather than
    // asserted beside it. Adding a flag from a newer release fails this test
    // until the README is updated, which is the whole point: a documented
    // version that nothing recomputes is a number that was true once.
    const versions = [...new Set(all.map((u) => FLAG_SINCE[u.key]).filter(Boolean))]
      .filter((v) => v !== undefined && !v.startsWith('<='))
      .map((v) => (v as string).split('.').map(Number))
    const highest = versions
      .sort(
        (a, b) =>
          (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0),
      )
      .at(-1)
    expect(highest, 'no versioned flag found — the comparison would be vacuous').toBeDefined()
    const floor = (highest as number[]).join('.')

    const readme = readFileSync('README.md', 'utf8')
    expect(readme, `README must name Compose v${floor} as the floor`).toContain(
      `Docker Compose v${floor}`,
    )
  })
})
