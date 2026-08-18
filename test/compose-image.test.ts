import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Assertions against `docker compose config`, which resolves interpolation
// without starting anything -- the same approach, and for the same reason, as
// `tls-config.test.ts`: these guard existing installs, and a guard that takes
// minutes is a guard that gets skipped.
//
// `--env-file` with an explicit file rather than the repo's own .env, because a
// developer machine has a real one and the default lookup would make this pass
// or fail depending on whose laptop it ran on. That matters more here than
// anywhere: LYRAFLOW_IMAGE is exactly the sort of variable someone would leave
// set in a shell after testing a scratch stack.
const composeConfig = (composeFile: string, envFileContents: string, args: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'lyraflow-image-cfg-'))
  const envFile = join(dir, 'env')
  writeFileSync(envFile, envFileContents)
  try {
    const out = execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        envFile,
        '--project-directory',
        '.',
        '-f',
        composeFile,
        'config',
        ...args,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    )
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Passwords are required for interpolation to resolve; the values are
// irrelevant to every assertion here.
const BASE = 'POSTGRES_PASSWORD=x\nCLICKHOUSE_PASSWORD=y\n'

// Parsed rather than pattern-matched. A regex for `"image"` after `"lyraflow"`
// runs past the end of that service object and happily matches the NEXT
// service's image, so the CI-stack case below reported `clickhouse`'s tag
// instead of the absence it is asserting on.
const imageOf = (composeFile: string, env: string): string | undefined => {
  const cfg = JSON.parse(composeConfig(composeFile, env, ['--format', 'json']))
  return cfg.services.lyraflow.image
}

describe('the app image name', () => {
  // install.sh runs `docker compose pull || docker compose build`, and the pull
  // half only works against the published tag. A refactor that dropped the
  // `:-` default would leave a fresh clone pulling an empty image name, which
  // is the failure this asserts against.
  it('is the published tag when nothing overrides it, so a fresh clone can still pull', () => {
    expect(imageOf('docker-compose.yml', BASE)).toBe('ghcr.io/lyraflow/lyraflow:0')
  })

  // The point of the variable. Without it, a second project built from this
  // checkout retags the shared name: `-p` and host ports isolate containers,
  // volumes and ports, but the image tag is a third namespace they do not
  // cover, and the swap is invisible until an ordinary `up -d` recreates the
  // dev container from whatever the scratch stack last built.
  it('is whatever LYRAFLOW_IMAGE says, so a scratch stack leaves the shared tag alone', () => {
    expect(imageOf('docker-compose.yml', `${BASE}LYRAFLOW_IMAGE=lyraflow-scratch:0\n`)).toBe(
      'lyraflow-scratch:0',
    )
  })

  // The other file with a `build:` for this service. It carries no `image:` at
  // all, so Compose derives the name from the project and a second CI project
  // cannot collide with anything. Asserted rather than assumed: adding an
  // `image:` here would reintroduce exactly the bug the variable above fixes,
  // and nothing else would notice.
  it('is left to Compose in the CI stack, which is why that one needs no override', () => {
    expect(imageOf('docker-compose.ci.yml', BASE)).toBeUndefined()
  })
})
