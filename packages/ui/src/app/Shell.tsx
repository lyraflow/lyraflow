import {
  ChevronDown,
  Filter,
  Grid3x3,
  LayoutDashboard,
  LayoutList,
  LineChart,
  LogOut,
  Settings as SettingsIcon,
  Star,
  UserRound,
  UserSearch,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import type { ApiClient } from '../api/client.js'
import type { Project } from '../api/types.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js'
import { useProject } from './ProjectContext.js'
import { ROUTES } from './Router.js'
import { ThemeToggle } from './ThemeToggle.js'
import { useVersion } from './useVersion.js'

// Lucide's default stroke (2, on a 24-unit box) reads heavier than the
// brand mark's (3.8, on a 100-unit box -- a ratio less than half as thick).
// These nav/header icons sit directly beside the mark, so their weight has
// to answer to it. 1.5 is the closest match that still holds up at 16px;
// the tiny utility glyphs baked into the vendored select/dropdown-menu
// (chevrons, checkmarks) are left at their own default since they never
// appear next to the mark at a comparable size.
const ICON_STROKE = 1.5

/**
 * One sidebar destination's classes, active or not.
 *
 * Written once and called seven times rather than spelled out at each link.
 * The seven were identical ternaries, which is how the eighth destination
 * gets added with the wrong ones -- or how six of seven pick up a change and
 * the last is found later by an operator rather than by a diff.
 *
 * **The active state carries a background fill, not only a colour step.**
 * Every item is `font-medium` and the active one differed from the rest by
 * `text-foreground` against `text-muted-foreground` -- one step on one
 * axis, which is not enough to answer "which screen am I on" at a glance.
 * The fill is deliberately the SAME `bg-muted` the hover state uses: asked
 * for by name, and it keeps the sidebar to two greys rather than inventing
 * a third. The cost is that hovering an inactive item makes it look
 * selected for as long as the pointer is on it. That ambiguity resolves
 * itself -- the pointer is the thing that caused it and the thing that ends
 * it -- which is why this is the fill rather than a second, louder one.
 *
 * `aria-current` is what actually announces the active destination to a
 * screen reader, and it is set at each link rather than here: `NavLink`
 * supplies its own, and the Feed link computes one by hand because it has a
 * second path (`/`) that must also count as active. This function only
 * dresses what those already decided.
 */
function navLinkClass(isActive: boolean): string {
  return `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium ${
    isActive
      ? 'bg-muted text-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`
}

function Mark() {
  return (
    <svg viewBox="0 0 100 100" className="h-5 w-5 shrink-0 text-primary" aria-hidden="true">
      <g
        stroke="currentColor"
        strokeWidth={3.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M90.00 17.79L65.83 28.34" />
        <path d="M65.83 28.34L37.93 30.70" />
        <path d="M37.93 30.70L10.00 82.21" />
        <path d="M10.00 82.21L36.85 80.29" />
        <path d="M36.85 80.29L65.83 28.34" />
      </g>
      <g fill="currentColor">
        <circle cx="90.00" cy="17.79" r="5.0" />
        <circle cx="65.83" cy="28.34" r="3.4" />
        <circle cx="37.93" cy="30.70" r="3.4" />
        <circle cx="10.00" cy="82.21" r="3.4" />
        <circle cx="36.85" cy="80.29" r="3.4" />
      </g>
    </svg>
  )
}

/**
 * The only control over which project every subsequent request names.
 *
 * The trigger's accessible role is deliberately overridden from Radix's
 * default "combobox" to "button" -- Radix spreads caller props after its
 * own `role`, so this wins without touching the vendored file. A plain
 * button matches how the switcher reads in the header (a click target with
 * a name, not a text input) and is what the rest of the app can rely on.
 */
/**
 * Archived projects sort last and say so, rather than being filtered out.
 *
 * Hiding them would break the case that actually happens: archiving the
 * project you are looking at. The switcher would then have no entry for
 * `activeId`, the trigger would read "Select project" while the screens
 * below kept answering for it, and there would be no way back to restore it
 * except Settings. Listed-and-labelled costs one suffix and has no such
 * state.
 */
function switcherLabel(project: Project): string {
  return project.disabled_at === null ? project.name : `${project.name} (archived)`
}

function byArchivedLast(a: Project, b: Project): number {
  const archived = Number(a.disabled_at !== null) - Number(b.disabled_at !== null)
  return archived !== 0 ? archived : 0
}

function ProjectSwitcher() {
  const { projects, activeId, setActiveId } = useProject()
  const active = projects.find((p) => p.id === activeId)
  // A deleting project is omitted outright, unlike an archived one -- there
  // is no restoring it, and switching to it would scope every screen to a
  // project mid-teardown. `active` above is still looked up against the
  // FULL `projects` list, not this filtered one: the active project itself
  // becoming the deleting one is a real case (deleting the project you are
  // looking at), and the trigger must keep naming it rather than reading
  // `undefined`.
  const visible = projects.filter((p) => p.deleting_at === null)
  // `toSorted` would be cleaner and is ES2023; this package targets a
  // browser baseline that does not have it everywhere yet, so the copy is
  // explicit. Sorting a copy matters either way: `projects` is context
  // state and sorting it in place would mutate what every other consumer
  // reads.
  const ordered = [...visible].sort(byArchivedLast)

  return (
    <Select
      value={activeId != null ? String(activeId) : undefined}
      onValueChange={(value) => setActiveId(Number(value))}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: SelectTrigger already renders a real <button>; this role replaces Radix's own "combobox" override, not a native element's implicit role. */}
      <SelectTrigger
        role="button"
        className="min-w-0 w-auto gap-1.5 border-0 bg-transparent shadow-none"
      >
        <SelectValue className="truncate">
          {active ? switcherLabel(active) : 'Select project'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ordered.map((project) => (
          <SelectItem key={project.id} value={String(project.id)}>
            {switcherLabel(project)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * A link, not a badge -- there is deliberately no star count here.
 *
 * The two obvious ways to show one both make an operator's dashboard talk
 * to a third party without being asked: GitHub's own buttons.github.io
 * widget, and a browser fetch of api.github.com. Either sends the IP of
 * every person who opens Lyraflow to GitHub, and neither works in an
 * install with no egress -- for a self-hosted analytics tool that is the
 * behaviour the product exists to avoid, not a detail. If a count is ever
 * wanted it has to come from the server, cached, with a way to turn it off.
 *
 * `noreferrer` is doing real work alongside `noopener`: without it the
 * outbound request carries this page's URL, which on a self-hosted install
 * is the operator's own hostname. That is private infrastructure, and it
 * is not GitHub's to learn.
 */
function StarOnGitHub() {
  return (
    <a
      href="https://github.com/lyraflow/lyraflow"
      target="_blank"
      rel="noreferrer noopener"
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border p-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 sm:px-2"
    >
      <Star className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
      {/* Visually hidden below `sm` for the same reason the nav labels are
       * -- the header already scrolls at 390px -- but kept in the DOM at
       * every width so the link's accessible name never depends on the
       * viewport. */}
      <span className="sr-only sm:not-sr-only">Star on GitHub</span>
    </a>
  )
}

function AccountMenu(props: { email: string | null; onLogout(): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          {/*
           * `email` is nullable (MINOR from the whole-branch review): the
           * server answers `{ email: null }` when the session cookie is
           * still valid but the admin row it names is gone. The account
           * menu -- and the "sign out" it leads to -- must still render in
           * that state rather than throwing or showing a blank label.
           */}
          <span className="truncate">{props.email ?? 'Unknown admin'}</span>
          <ChevronDown className="h-4 w-4 shrink-0" strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* `asChild` so this is a real anchor: an account menu entry that
         * cannot be middle-clicked or opened in a new tab is a button
         * pretending to be a link, and `react-router`'s Link is what the
         * rest of this shell navigates with. */}
        <DropdownMenuItem asChild>
          <Link to={ROUTES.profile}>
            <UserRound className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onLogout()}>
          <LogOut className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Shell(props: {
  email: string | null
  onLogout(): void
  client: ApiClient
  children?: ReactNode
}) {
  /**
   * No `onUnauthorized` passed, deliberately -- unlike the Settings card,
   * which routes back to login on a 401 from the same fetch. This is chrome
   * on every screen, and making a decorative element a third trigger for
   * "sign out and bounce to login" (beside `App`'s session poll and `Feed`'s
   * own detector) widens what a failed version read can do to an operator
   * mid-task. It stays silent instead.
   */
  const { version } = useVersion(props.client)
  // `Router.tsx` answers `/` with the SAME element as `/feed` (a bare hard
  // refresh at the root has to land somewhere), but `NavLink`'s own
  // `isActive` match is computed from `to` against the current location, so
  // a Feed link `to="/feed" end` never matches `/` itself -- neither nav
  // item got `aria-current` there, the exact state every operator lands on
  // right after login (and right after the wizard, which has no route of
  // its own to redirect through). Computed by hand here, rather than
  // relying on `NavLink`'s own match, only for the Feed link's extra case.
  const { pathname } = useLocation()
  const feedActive = pathname === '/' || pathname === ROUTES.feed
  // Dashboards now links to `/dashboards/home` (O1: the sidebar entry opens
  // the starred dashboard when one exists), so it can no longer rely on
  // `NavLink`'s own match against `to` -- that would only mark it current
  // AT `/dashboards/home` itself, and a click on it actually lands on
  // `/dashboards/:id` or falls back to the list. Current on the list route
  // and on any dashboard's own screen, mirroring `feedActive`'s hand-computed
  // match above for the same reason: the link's destination and the set of
  // routes it should read as "current" for are not the same set.
  const dashboardsActive = pathname === ROUTES.dashboards || pathname.startsWith('/dashboards/')
  return (
    // `flex-col` below `sm`, `flex-row` at and above it: a 224px fixed
    // sidebar leaves a 390px viewport with less than half its width for
    // everything else, and no amount of truncation in the header made that
    // usable (see the two-star screenshot review that sent this back). The
    // aside below carries the same reflow -- laid out as a vertical sidebar
    // at `sm:` and a compact top bar under it -- on purpose: two separate
    // DOM copies gated by `hidden`/`flex` classes would both be visible to
    // Shell.test.tsx (jsdom has no Tailwind stylesheet loaded, so `hidden`
    // never actually hides anything there), turning a text query into a
    // multiple-match failure. One element that reflows has no such seam.
    <div className="flex h-dvh flex-col bg-background text-foreground sm:flex-row">
      <aside className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-4 sm:w-56 sm:flex-col sm:items-stretch sm:gap-0 sm:border-b-0 sm:border-r sm:px-0">
        {/* The product is Lyraflow, not "Lyra" -- pre-existing on `main`,
         * predating this branch, but this file is already touched here and
         * the wordmark spec's hand-set kern pairs (e.g. `fl`) only exist in
         * the full name.
         *
         * O2: a real `Link` to `/`, not a decorative group -- the mark is
         * now a second way back to the starred dashboard (or the feed, when
         * there isn't one) beside the sidebar's own Dashboards entry.
         * `aria-label` overrides the accessible name to say where it goes
         * ("home") rather than leaving it as just the wordmark text, the
         * same reason every other icon-plus-label control in this sidebar
         * keeps its visible text -- SAME classes as the div this replaces,
         * so it looks identical. */}
        <Link
          to="/"
          aria-label="Lyraflow home"
          className="flex h-14 items-center gap-2 font-semibold sm:border-b sm:border-border sm:px-4"
        >
          <Mark />
          Lyraflow
        </Link>
        <nav className="flex items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5 sm:p-2">
          {/*
           * O1: this now opens the starred dashboard directly
           * (`/dashboards/home`, resolved by `Router.tsx`'s `HomeEntry`)
           * rather than always the list -- so it's a plain `Link`, like
           * Feed, with `aria-current` computed by hand from
           * `dashboardsActive` above rather than from `NavLink`'s own match
           * against `to`: that match is against the LINK'S destination,
           * which is `/dashboards/home`, not against every route a click on
           * it can actually land on.
           */}
          <Link
            to={ROUTES.dashboardsHome}
            aria-current={dashboardsActive ? 'page' : undefined}
            className={navLinkClass(dashboardsActive)}
          >
            <LayoutDashboard className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Dashboards</span>
          </Link>
          {/*
           * Real links now that `Router.tsx` gives this app somewhere to
           * route to -- Important 10 previously ruled out a plain anchor
           * here because there was no router, so any `<a href>` performed a
           * full browser navigation for no reason. Settings uses `NavLink`
           * directly below, which supplies `aria-current="page"` for its own
           * route with nothing more needed.
           *
           * Feed uses a plain `Link` instead, with `aria-current` computed
           * by hand from `feedActive` above: `NavLink`'s OWN `isActive`
           * match is computed from `to` against the current location
           * internally, and cannot be overridden by passing an
           * `aria-current` prop -- react-router only uses that prop as the
           * VALUE to apply once its own match says active, not as a way to
           * force the match itself, so it can't be made to also cover `/`.
           */}
          <Link
            to={ROUTES.feed}
            aria-current={feedActive ? 'page' : undefined}
            className={navLinkClass(feedActive)}
          >
            <LayoutList className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            {/* Three destinations no longer fit as icon+label at 390px (see
             * this task's own brief: the switcher truncated to "Ce" and a
             * tab label to "ed 1"). The label stays in the DOM at every
             * width -- only visually hidden below `sm` -- so the link's
             * accessible name never depends on viewport size, and no
             * `aria-label` duplicate is needed alongside it. */}
            <span className="sr-only sm:not-sr-only">Feed</span>
          </Link>
          {/* `NavLink`, exactly as Settings uses it below -- it supplies
           * `aria-current="page"` itself, and unlike Feed there is no
           * second path (`/`) that also has to count as "on this screen". */}
          <NavLink to={ROUTES.funnels} className={({ isActive }) => navLinkClass(isActive)}>
            <Filter className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Funnels</span>
          </NavLink>
          <NavLink to={ROUTES.trends} className={({ isActive }) => navLinkClass(isActive)}>
            <LineChart className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Trends</span>
          </NavLink>
          <NavLink to={ROUTES.retention} className={({ isActive }) => navLinkClass(isActive)}>
            <Grid3x3 className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Retention</span>
          </NavLink>
          <NavLink to={ROUTES.segments} className={({ isActive }) => navLinkClass(isActive)}>
            <Users className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Segments</span>
          </NavLink>
          <NavLink to={ROUTES.people} className={({ isActive }) => navLinkClass(isActive)}>
            <UserSearch className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">People</span>
          </NavLink>
          <NavLink to={ROUTES.settings} className={({ isActive }) => navLinkClass(isActive)}>
            <SettingsIcon className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Settings</span>
          </NavLink>
        </nav>
        {/*
         * `sm:mt-auto` pins it to the foot of the sidebar; `hidden sm:block`
         * keeps it out of the compact top bar this aside becomes below `sm`,
         * which already scrolls horizontally at 390px and is why the nav
         * labels are `sr-only` there. Nothing is lost narrow: the Settings
         * screen's Install card carries the version at every width, with the
         * release-notes link this deliberately does not repeat.
         */}
        {version !== null && (
          <p
            data-testid="sidebar-version"
            className="hidden text-xs text-muted-foreground sm:mt-auto sm:flex sm:items-center sm:gap-1.5 sm:px-4 sm:pb-4"
          >
            <span>v{version}</span>
            {/*
             * `CHANGELOG.md` on `main`, NOT this version's tag -- the two
             * answer different questions and the card already answers the
             * other one. Its "Release notes" link goes to
             * `/releases/tag/v<version>`: what shipped in the version you are
             * running. From a running install the useful question is the
             * opposite one, what has shipped SINCE, and the file is
             * newest-first so it opens on exactly that. It also cannot 404,
             * which the tag link can before a release object exists.
             *
             * The brackets are part of the link text rather than decoration
             * around it, so the accessible name contains the visible label
             * (WCAG 2.5.3) instead of differing from it by punctuation.
             *
             * Third outbound GitHub link in this file, and `noreferrer` earns
             * its place for the third time: see `StarOnGitHub` above. A
             * self-hosted install's hostname is not GitHub's to learn.
             */}
            <a
              href="https://github.com/lyraflow/lyraflow/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noreferrer noopener"
              className="underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              [changelog]
            </a>
          </p>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
         * `overflow-x-auto` is the backstop, not the primary fix: the
         * project name and email above already shrink and truncate first.
         * Now that the sidebar reflows away below `sm` instead of sitting
         * fixed at 224px, the three controls usually fit -- but this is
         * what stops the rare case (a very long project name, say) from
         * becoming page-level horizontal scroll (the same failure this
         * task's overflow check exists to catch) instead of a scroll
         * confined to the header bar.
         */}
        <header className="flex h-14 min-w-0 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-border bg-card px-4">
          <ProjectSwitcher />
          <div className="flex min-w-0 shrink items-center gap-2">
            <StarOnGitHub />
            <ThemeToggle />
            <AccountMenu email={props.email} onLogout={props.onLogout} />
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-auto p-6">{props.children}</main>
      </div>
    </div>
  )
}
