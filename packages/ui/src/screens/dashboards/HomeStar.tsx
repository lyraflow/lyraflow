import { Star } from 'lucide-react'
import { Button } from '../../components/ui/button.js'

/**
 * `Shell.tsx` keeps its own `ICON_STROKE = 1.5` as a module-local constant
 * rather than exporting one, so there is nothing to import here. 1.75 is the
 * weight this icon needs at 16px: the star is a five-pointed outline and at
 * 1.5 its points thin out enough that the empty state reads as a smudge
 * beside the crisp `sm` buttons next to it in the dashboard header.
 */
const STROKE = 1.75

/**
 * What the button is CALLED depends on which way it goes, and the two are
 * deliberately different kinds of phrase: unset names the action ("Set … as
 * home dashboard"), set names the state and then the action ("… is the home
 * dashboard — click to unset"). A star with no text has nothing else to say
 * which state it is in, and `aria-pressed` alone is read out as a bare
 * "pressed" by some screen readers and not at all by others.
 *
 * `name` is optional because the two callers need different things. The
 * dashboard screen shows exactly one dashboard, so there is nothing to
 * disambiguate from and the shorter label is the better one. The list
 * renders one star per row, where "Set as home dashboard" repeated six
 * times names nothing.
 */
function label(isHome: boolean, name?: string): string {
  if (isHome) {
    return name === undefined
      ? 'Home dashboard — click to unset'
      : `"${name}" is the home dashboard — click to unset`
  }
  return name === undefined ? 'Set as home dashboard' : `Set "${name}" as home dashboard`
}

/**
 * The home-dashboard toggle: an empty star for "not home", a filled one for
 * "home", in the dashboard header (both modes) and on every row of the
 * dashboards list.
 *
 * It is a toggle and not a one-way switch, which is why the filled star is
 * clickable at all: a project is allowed to have no home dashboard, and
 * before this the only way back to that state was to delete the dashboard.
 *
 * Deliberately stateless. Whether a dashboard is home is the server's
 * answer, and both callers already replace their local copy with the `PATCH`
 * response -- so this renders `isHome` as given and never anticipates the
 * result of its own click. A star that filled optimistically would show the
 * wrong project home for as long as a failing request takes to fail.
 */
export function HomeStar(props: {
  isHome: boolean
  onToggle(): void
  disabled?: boolean
  name?: string
}) {
  const { isHome, onToggle, disabled, name } = props

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label(isHome, name)}
      aria-pressed={isHome}
      disabled={disabled}
      onClick={onToggle}
    >
      {/* `fill` is the entire difference between the two states, so it is
       * set explicitly in BOTH -- lucide's own default is `fill="none"`,
       * and relying on it would make "empty" a property of the icon library
       * rather than of this component. `text-foreground` on the filled star
       * because `ghost` leaves the button at the inherited colour, which in
       * a muted list row is the grey used for metadata. */}
      <Star
        className={isHome ? 'h-4 w-4 text-foreground' : 'h-4 w-4'}
        strokeWidth={STROKE}
        fill={isHome ? 'currentColor' : 'none'}
        aria-hidden="true"
      />
    </Button>
  )
}
