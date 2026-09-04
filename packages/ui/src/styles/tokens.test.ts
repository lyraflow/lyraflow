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
// Derived from the CSS itself, not hand-copied -- a stray or missing block
// fails the very next assertion rather than silently not being checked.
const PALETTES = [
  ...new Set([...tokens.matchAll(/^\[data-palette="([a-z]+)"\] \{/gm)].map((m) => m[1] as string)),
]
// The product-defined id list (see `app/palette.ts`), independent of what
// the CSS under test happens to contain -- the resolution test below needs
// this fixed set so a missing block shows up as a wrong VALUE, not as an id
// silently dropped from the loop.
const ALL_PALETTE_IDS = ['copper', 'cobalt', 'moss', 'plum', 'slate', 'wine', 'amber']
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

// Like `block`, but tells the caller a selector has no block instead of
// throwing -- used only by the resolution test below, which has to model
// the pre-fix CSS where `[data-palette="copper"]` did not exist yet.
function tryBlock(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm'))
  return m === null ? undefined : (m[1] as string)
}

function names(blockText: string): string[] {
  return [...blockText.matchAll(/--lf-([a-z0-9-]+):/g)].map((m) => m[1] as string).sort()
}

function decls(blockText: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of blockText.matchAll(/--lf-([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim()
  }
  return out
}

describe('brand/tokens.css palettes', () => {
  it('the CSS has exactly the seven palette ids the product defines, copper first', () => {
    expect(PALETTES).toEqual(ALL_PALETTE_IDS)
  })

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

  it('copper has its own blocks, so a swatch scoped to copper resolves copper while another palette is active', () => {
    const expected = [...STEPS.map((s) => `accent-${s}`), ...ROLES].sort()
    expect(names(block(tokens, '[data-palette="copper"]'))).toEqual(expected)
    const preferred = block(tokens, ':root:not([data-theme="light"])[data-palette="copper"]')
    const explicit = block(tokens, ':root[data-theme="dark"][data-palette="copper"]')
    expect(names(preferred)).toEqual([...ROLES].sort())
    expect(names(explicit)).toEqual([...ROLES].sort())
  })

  it("every swatch resolves its own palette's 500 step whatever the root palette is", () => {
    // Models the cascade for the Appearance picker: each swatch is a `<span
    // data-palette="…">` inside a page carrying its own `data-palette` (or
    // none, meaning copper) on `<html>`. A property declared on a selector
    // that matches the element itself always wins over one inherited from an
    // ancestor, so a swatch's OWN block -- when it has one -- decides its
    // `--lf-accent-500`; only a swatch with no block of its own falls back to
    // whatever the root resolves to. Before the fix, copper had no block, so
    // the copper swatch fell back to the root and painted the active
    // palette's 500 step instead of copper's.
    const ids = ALL_PALETTE_IDS // fixed, so a missing block shows as a wrong value
    const rootDecls = decls(block(tokens, ':root'))
    const lightBlocks: Record<string, Record<string, string> | undefined> = {}
    for (const id of ids) {
      const b = tryBlock(tokens, `[data-palette="${id}"]`)
      lightBlocks[id] = b === undefined ? undefined : decls(b)
    }

    for (const rootPalette of ids) {
      for (const swatchPalette of ids) {
        // What the cascade actually resolves to, given which blocks exist.
        const resolved =
          lightBlocks[swatchPalette]?.['accent-500'] ??
          lightBlocks[rootPalette]?.['accent-500'] ??
          rootDecls['accent-500']
        // The ground truth: a swatch scoped to `swatchPalette` must show
        // THAT palette's own 500 step -- copper's own truth is :root's
        // ramp, which the fix does not change, only restates.
        const expected = lightBlocks[swatchPalette]?.['accent-500'] ?? rootDecls['accent-500']
        expect(resolved, `root=${rootPalette} swatch=${swatchPalette}`).toBe(expected)
      }
    }
  })
})
