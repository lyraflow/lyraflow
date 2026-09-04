import { useState } from 'react'
import {
  PALETTES,
  type PaletteId,
  applyPalette,
  readStoredPalette,
  storePalette,
} from '../../app/palette.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'

/**
 * The accent picker. Seven swatches, one radio group, applied on change
 * with no save button -- the page IS the preview, and a preference that
 * needs confirming is a preference the operator will not try.
 *
 * Native `<input type="radio">`s, visually hidden, inside labels: that is
 * what gives the group arrow-key movement, a single tab stop and a checked
 * state for free, and it is what Biome's `useSemanticElements` would insist
 * on if this were a `<button role="radio">`. A `<fieldset>` with a
 * `<legend>` names the group the same way.
 *
 * The swatch is scoped to its own palette with `data-palette` on the
 * element, and paints `--lf-accent-500` -- the ramp's mid step, not the
 * `accent` role. The role is set on `:root` selectors and would not resolve
 * on a descendant; the ramp steps are set on a bare `[data-palette]`
 * selector and are the same in both modes. That is also why there is no hex
 * anywhere in this file: the swatch shows the token the page would use.
 *
 * The light/dark toggle stays in the header and is deliberately not
 * repeated here -- one control per preference.
 */
export function AppearanceSection() {
  const [current, setCurrent] = useState<PaletteId>(() => readStoredPalette())

  const choose = (id: PaletteId) => {
    setCurrent(id)
    applyPalette(id)
    storePalette(id)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-muted-foreground text-xs">
            <span className="sr-only">Accent colour. </span>
            Stored in this browser. Changes the accent colour only.
          </legend>
          <div className="flex flex-wrap gap-4">
            {PALETTES.map((p) => {
              const checked = p.id === current
              return (
                <label
                  key={p.id}
                  className="flex cursor-pointer flex-col items-center gap-1 rounded-md p-1"
                >
                  <input
                    type="radio"
                    name="accent-palette"
                    value={p.id}
                    checked={checked}
                    onChange={() => choose(p.id)}
                    className="peer sr-only"
                  />
                  <span
                    data-testid={`swatch-${p.id}`}
                    data-palette={p.id}
                    aria-hidden="true"
                    style={{ background: 'var(--lf-accent-500)' }}
                    className={
                      checked
                        ? 'size-8 rounded-full ring-2 ring-foreground ring-offset-2 ring-offset-card peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-focus-visible:outline-offset-2'
                        : 'size-8 rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-focus-visible:outline-offset-2'
                    }
                  />
                  <span className={checked ? 'text-xs' : 'text-muted-foreground text-xs'}>
                    {p.label}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  )
}
