import { describe, expect, it } from 'vitest'
// `?raw` hands back the file's text. This tests the token file the app
// actually ships -- theme.css @imports it -- rather than a parsed copy.
import tokens from '../../../../brand/tokens.css?raw'
import theme from './theme.css?raw'

/**
 * Pins the shape of the palette blocks, not their values -- the values are
 * measured by the brand tooling and reported in brand/contrast-report.txt.
 * What this guards is the "accent only" boundary: a palette may restate the
 * accent ramp and the five accent roles, and nothing else. A palette that
 * grows a surface override would pass every contrast check for its own
 * accent and still break the body-on-surface pairing, which nothing measures
 * per palette because nothing is supposed to change it.
 */
const PALETTES = ['cobalt', 'moss', 'plum', 'slate', 'wine', 'amber']
const ROLES = ['accent', 'accent-hover', 'accent-surface', 'accent-border', 'on-accent']
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]

/**
 * The block whose selector is exactly `selector` at the start of a line.
 * Anchored, because `[data-palette="cobalt"] {` is also the TAIL of the
 * media-scoped selector, and a bare indexOf would pick whichever came first.
 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm'))
  if (m === null) throw new Error(`no block for ${selector}`)
  return m[1] as string
}

function names(blockText: string): string[] {
  return [...blockText.matchAll(/--lf-([a-z0-9-]+):/g)].map((m) => m[1] as string).sort()
}

describe('brand/tokens.css palettes', () => {
  it('names the ramp accent-*, never copper-*', () => {
    expect(tokens).not.toContain('--lf-copper-')
    expect(theme).not.toContain('--lf-copper-')
    for (const step of STEPS) expect(tokens).toContain(`--lf-accent-${step}:`)
  })

  it('the funnel ramp in theme.css reads the accent ramp', () => {
    for (let i = 1; i <= 7; i++) {
      expect(theme).toMatch(new RegExp(`--chart-funnel-${i}: var\\(--lf-accent-\\d+\\)`))
    }
  })

  it.each(PALETTES)('%s: light block is the ten steps plus the five roles, nothing else', (id) => {
    const expected = [...STEPS.map((s) => `accent-${s}`), ...ROLES].sort()
    expect(names(block(tokens, `[data-palette="${id}"]`))).toEqual(expected)
  })

  it.each(PALETTES)('%s: both dark blocks are exactly the five roles', (id) => {
    const preferred = block(tokens, `:root:not([data-theme="light"])[data-palette="${id}"]`)
    const explicit = block(tokens, `:root[data-theme="dark"][data-palette="${id}"]`)
    expect(names(preferred)).toEqual([...ROLES].sort())
    expect(names(explicit)).toEqual([...ROLES].sort())
  })

  it('copper has no block: an absent attribute is the default', () => {
    expect(tokens).not.toContain('[data-palette="copper"]')
  })
})
