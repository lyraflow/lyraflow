import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

/** The two a page can actually be rendered in. `system` is a way of not
 * choosing, not a third appearance. */
type Applied = 'light' | 'dark'

const KEY = 'lf-theme'

/**
 * THREE states, still, and the third is still the default -- but only TWO of
 * them are reachable from the control.
 *
 * tokens.css defines light on :root, dark under prefers-color-scheme guarded
 * by :not([data-theme="light"]), and dark again under [data-theme="dark"].
 * An ABSENT data-theme is therefore "follow the system", and is a real,
 * working state: writing an explicit value on first load would override
 * every visitor's system preference before they ever touched the control.
 *
 * What changed is the control, not the model. Cycling through a state called
 * "system" asked an operator to understand the model before they could pick
 * a colour, and two thirds of the clicks did not do the thing they wanted.
 * The button now shows one icon and flips between light and dark; nothing is
 * written to storage until it is clicked, so a first visit still follows the
 * machine it is on.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

export function readStoredTheme(): ThemeChoice {
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

/**
 * What the operating system is asking for right now.
 *
 * Optional-called because jsdom implements no `matchMedia` at all, and the
 * component must render in a test environment without one -- falling back to
 * light, which is the canonical mode (see the brand guide) and what an
 * absent preference has always produced.
 */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme())
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark())

  // Tracked live, because "follow the system" has to keep following it: an
  // operator switching their laptop to dark at sunset, having never touched
  // this control, gets a dark page without reloading. The CSS already does
  // this on its own -- the subscription is what keeps the ICON from going
  // stale and offering to switch to the mode already on screen.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    applyTheme(choice)
    // `system` REMOVES the key rather than storing the word: an absent key
    // is what "never chose" means everywhere else here, and storing a third
    // value would make a stale bundle from before this change read it as an
    // explicit choice it is not.
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  }, [choice])

  const applied: Applied = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
  const target: Applied = applied === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      // Names the ACTION, not the state. A control labelled "dark" on a light
      // page is ambiguous about which one it is telling you -- and it is the
      // only text a screen reader gets, since the icon is decorative.
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
      className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      onClick={() => setChoice(target)}
    >
      {target === 'dark' ? (
        <Moon className="size-4" aria-hidden="true" />
      ) : (
        <Sun className="size-4" aria-hidden="true" />
      )}
    </button>
  )
}
