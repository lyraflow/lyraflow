import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Static assertions on the workflow that publishes the container image. It
// only runs on a tag push, so a mistake in it surfaces on release day, in
// public, as either no image or an image nobody asked for. These pin the
// properties that make it safe to trigger at all.
//
// Text, not a YAML parser: the repository has no YAML dependency, and adding
// one for a single test file is a poor trade. The helpers below read only the
// shapes this one file uses: top-level keys at column 0, two-space indents.
const WORKFLOW = '.github/workflows/image.yml'
const IMAGE = 'ghcr.io/lyraflow/lyraflow'

const lines = (): string[] =>
  readFileSync(WORKFLOW, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => l.replace(/\s+#.*$/, '').trimEnd())

// The body of a key at the given indent: every following line indented deeper,
// stopping at the next line at that indent or shallower.
const block = (all: string[], key: string, indent = 0): string[] => {
  const pad = ' '.repeat(indent)
  const start = all.findIndex((l) => l === `${pad}${key}:` || l.startsWith(`${pad}${key}: `))
  if (start === -1) return []
  const out: string[] = []
  for (const l of all.slice(start + 1)) {
    if (l.length - l.trimStart().length <= indent) break
    out.push(l)
  }
  return out
}

const job = (name: string): string[] => block(block(lines(), 'jobs'), name, 2)

describe('the image workflow', () => {
  it('is triggered by a pushed v* tag and by nothing else', () => {
    expect(block(lines(), 'on')).toEqual(['  push:', "    tags: ['v*']"])
  })

  it('grants contents: read and packages: write at the top level, and nothing broader', () => {
    expect([...block(lines(), 'permissions')].sort()).toEqual([
      '  contents: read',
      '  packages: write',
    ])
  })

  it('never widens permissions inside a job', () => {
    expect(block(lines(), 'jobs').filter((l) => /^\s+permissions:/.test(l))).toEqual([])
  })

  it('builds linux/amd64 on an ubuntu-24.04 runner', () => {
    expect(job('build').join('\n')).toMatch(/- platform: linux\/amd64\n\s+runner: ubuntu-24\.04\n/)
  })

  it('builds linux/arm64 natively on an ubuntu-24.04-arm runner', () => {
    expect(job('build').join('\n')).toMatch(
      /- platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm\n/,
    )
  })

  // The matrix names a runner per platform; this is what makes the job use it.
  // Without it both legs land on one architecture and arm64 is emulated, or
  // simply wrong.
  it('runs each build leg on its own matrix runner', () => {
    expect(job('build')).toContain('    runs-on: ${{ matrix.runner }}')
  })

  it('builds exactly the matrix platform in each leg', () => {
    expect(job('build')).toContain('          platforms: ${{ matrix.platform }}')
  })

  it('uses no QEMU emulation', () => {
    expect(lines().some((l) => l.includes('setup-qemu-action'))).toBe(false)
  })

  it('pushes each leg by digest only, so no leg ever publishes a tag on its own', () => {
    expect(job('build')).toContain(
      `          outputs: type=image,name=${IMAGE},push-by-digest=true,name-canonical=true,push=true`,
    )
  })

  it('merges only after every build leg has succeeded', () => {
    expect(job('merge')).toContain('    needs: build')
  })

  it('assembles the multi-arch manifest with docker buildx imagetools create', () => {
    expect(job('merge').join('\n')).toMatch(/docker buildx imagetools create /)
  })

  it.each([
    'type=semver,pattern={{version}}',
    'type=semver,pattern={{major}}.{{minor}}',
    'type=semver,pattern={{major}}',
    'type=raw,value=latest',
  ])('publishes the tag %s', (tag) => {
    expect(block(job('merge'), 'tags', 10).map((l) => l.trim())).toContain(tag)
  })

  // A floating tag like `@v4` can be moved by whoever controls that repository,
  // and this workflow holds a token that can overwrite every published image.
  it('pins every action to a full commit SHA', () => {
    const uses = lines().filter((l) => /^\s+(- )?uses: /.test(l))
    expect(uses.length).toBeGreaterThan(0)
    for (const l of uses) expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })
})
