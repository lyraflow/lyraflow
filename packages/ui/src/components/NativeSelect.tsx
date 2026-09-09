import { ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../lib/utils.js'

/**
 * The one native `<select>` in this product, styled to match the vendored
 * Radix `SelectTrigger` that the project switcher uses.
 *
 * **It stays a real `<select>` deliberately** (spec 2026-09-09, D1). Eighty-seven
 * `userEvent.selectOptions` calls across twenty-five test files drive these, and
 * that helper understands nothing else; `dashboards/AddTilePicker.tsx` and
 * `segments/OperatorSelect.tsx` also use `<optgroup>`, which Radix would need
 * `SelectGroup`/`SelectLabel` to replace. The cost, accepted openly: the OPEN
 * list is drawn by the OS and will not match the switcher's popup. The closed
 * control is what appears in every screenshot and in nearly all use.
 *
 * The class string below is `SelectTrigger`'s own (`components/ui/select.tsx:39-46`)
 * with the Radix-only parts dropped -- `data-[placeholder]`, the
 * `*:data-[slot=select-value]` set and `data-[size]`, none of which exist on a
 * native element -- and four things ADDED that the nineteen hand-copied strings
 * this replaces were all missing: `appearance-none` plus the chevron, the
 * focus-visible ring, the transition and disabled/aria-invalid states, and the
 * dark-mode background. `h-9` is stated rather than left to `data-[size]`
 * because every call site was already `h-9` and none of them ask for `sm`.
 *
 * `bg-transparent`, not the `bg-background` those nineteen used: several of these
 * sit inside a `Card`, where a flat page background is a visible rectangle in a
 * lighter panel, and it is what the switcher does.
 *
 * `[&>option]:bg-popover [&>option]:text-foreground` is here because the open-list
 * check (spec 2026-09-09, step 5) failed without it: a `bg-transparent` select
 * hands Chromium/Linux an unresolved popup background, and the open list rendered
 * white with barely-visible pale text while the page was in dark mode (verified
 * with Playwright chromium, both themes, list open). `bg-popover` gives it an
 * explicit background; `text-foreground` -- not `text-popover-foreground`, which
 * this codebase never maps and would compile to no rule at all -- pairs `--lf-text`
 * with `--lf-surface-raised`, the same body-on-raised-surface contrast the brand
 * system already measures, so the list gets a real, correct colour in both themes
 * instead of relying on Chromium to pick one.
 */
export function NativeSelect({
  className,
  containerClassName,
  children,
  ...props
}: ComponentProps<'select'> & { containerClassName?: string }) {
  return (
    <div className={cn('relative inline-flex min-w-0 items-center', containerClassName)}>
      <select
        className={cn(
          'h-9 min-w-0 max-w-full appearance-none rounded-md border border-input bg-transparent py-2 pr-8 pl-3 text-foreground text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 [&>option]:bg-popover [&>option]:text-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {/* Decoration only: the select already has its own accessible name, and
       * a chevron that took pointer events would swallow the click meant to
       * open the list. */}
      <ChevronDown
        className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  )
}
