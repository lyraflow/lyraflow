import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'lf-theme'

/**
 * THREE states, not two, and the third is the default.
 *
 * tokens.css defines light on :root, dark under prefers-color-scheme
 * guarded by :not([data-theme="light"]), and dark again under
 * [data-theme="dark"]. That means an ABSENT data-theme is "follow the
 * system" and is a real, working state -- so writing an explicit value on
 * first load would override every visitor's system preference before they
 * ever touched the control.
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

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme())

  useEffect(() => {
    applyTheme(choice)
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  }, [choice])

  const next: Record<ThemeChoice, ThemeChoice> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  }

  return (
    <button
      type="button"
      aria-label={`Theme: ${choice}`}
      // Hidden below `sm`: at a phone-width viewport the header only has
      // room for the project switcher and the account menu (sign-out lives
      // there) before it has to scroll -- and sign-out matters more than
      // theme switching does. This control is still reachable at any width
      // wide enough to show it comfortably, and the toggle remembers its
      // last choice either way (see `readStoredTheme` above).
      className="hidden shrink-0 rounded-md border border-border px-2 py-1 text-sm text-muted-foreground sm:block"
      onClick={() => setChoice(next[choice])}
    >
      {choice}
    </button>
  )
}
