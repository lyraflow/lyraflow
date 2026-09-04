/**
 * Which accent the UI is drawn in. Copper is the brand and the default; the
 * six others are the same ramp with the hue swapped, generated and measured
 * by the brand tooling (`brand/tokens.css`, `brand/contrast-report.txt`).
 *
 * Same model as `ThemeToggle.tsx`, deliberately: an attribute on `<html>`
 * that `tokens.css` keys its override blocks on, and one localStorage key.
 * An ABSENT attribute is copper -- there is no `[data-palette="copper"]`
 * block and there must never be one, so that a first visit, a cleared
 * storage and a removed palette all land on the same default for the same
 * reason. Per browser, not per account: a colour is the operator's own
 * taste, and syncing it would need a migration and an endpoint for a
 * preference the browser already keeps.
 */
export type PaletteId = 'copper' | 'cobalt' | 'moss' | 'plum' | 'slate' | 'wine' | 'amber'

export const PALETTES: ReadonlyArray<{ id: PaletteId; label: string }> = [
  { id: 'copper', label: 'Copper' },
  { id: 'cobalt', label: 'Cobalt' },
  { id: 'moss', label: 'Moss' },
  { id: 'plum', label: 'Plum' },
  { id: 'slate', label: 'Slate' },
  { id: 'wine', label: 'Wine' },
  { id: 'amber', label: 'Amber' },
]

export const DEFAULT_PALETTE: PaletteId = 'copper'

/** Read by the inline boot script in index.html too; change both or neither. */
export const PALETTE_KEY = 'lf-palette'

export function isPaletteId(raw: unknown): raw is PaletteId {
  return typeof raw === 'string' && PALETTES.some((p) => p.id === raw)
}

export function applyPalette(id: PaletteId): void {
  const root = document.documentElement
  if (id === DEFAULT_PALETTE) root.removeAttribute('data-palette')
  else root.setAttribute('data-palette', id)
}

/**
 * Copper for anything that is not one of the seven -- including a palette
 * that a later release removes, which is why this narrows rather than
 * trusting the stored string. The raw value must never reach the attribute.
 */
export function readStoredPalette(): PaletteId {
  const raw = localStorage.getItem(PALETTE_KEY)
  return isPaletteId(raw) ? raw : DEFAULT_PALETTE
}

/**
 * Copper REMOVES the key rather than storing the word, for the same reason
 * the theme toggle does for `system`: an absent key is what "never chose"
 * means everywhere, and a stale bundle from before a palette existed must
 * not find a value it cannot read.
 */
export function storePalette(id: PaletteId): void {
  if (id === DEFAULT_PALETTE) localStorage.removeItem(PALETTE_KEY)
  else localStorage.setItem(PALETTE_KEY, id)
}
