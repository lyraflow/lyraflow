import { ChevronDown, LayoutList, LogOut, Settings as SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
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
import { ThemeToggle } from './ThemeToggle.js'

// Lucide's default stroke (2, on a 24-unit box) reads heavier than the
// brand mark's (3.8, on a 100-unit box -- a ratio less than half as thick).
// These nav/header icons sit directly beside the mark, so their weight has
// to answer to it. 1.5 is the closest match that still holds up at 16px;
// the tiny utility glyphs baked into the vendored select/dropdown-menu
// (chevrons, checkmarks) are left at their own default since they never
// appear next to the mark at a comparable size.
const ICON_STROKE = 1.5

const NAV: Array<{ href: string; label: string; icon: typeof LayoutList }> = [
  { href: '/feed', label: 'Feed', icon: LayoutList },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
]

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
function ProjectSwitcher() {
  const { projects, activeId, setActiveId } = useProject()
  const active = projects.find((p) => p.id === activeId)

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
        <SelectValue className="truncate">{active?.name ?? 'Select project'}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={String(project.id)}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AccountMenu(props: { email: string; onLogout(): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          <span className="truncate">{props.email}</span>
          <ChevronDown className="h-4 w-4 shrink-0" strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => props.onLogout()}>
          <LogOut className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Shell(props: { email: string; onLogout(): void; children: ReactNode }) {
  return (
    // `flex-col` below `sm`, `flex-row` at and above it: a 224px fixed
    // sidebar leaves a 390px viewport with less than half its width for
    // everything else, and no amount of truncation in the header made that
    // usable (see the two-star screenshot review that sent this back). The
    // aside below carries the same reflow -- one set of NAV links, laid out
    // as a vertical sidebar at `sm:` and a compact top bar under it -- on
    // purpose: two separate DOM copies of "Feed"/"Settings" gated by
    // `hidden`/`flex` classes would both be visible to Shell.test.tsx (jsdom
    // has no Tailwind stylesheet loaded, so `hidden` never actually hides
    // anything there), turning `getByRole('link', { name: /feed/i })` into a
    // multiple-match failure. One element that reflows has no such seam.
    <div className="flex h-dvh flex-col bg-background text-foreground sm:flex-row">
      <aside className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-4 sm:w-56 sm:flex-col sm:items-stretch sm:gap-0 sm:border-b-0 sm:border-r sm:px-0">
        <div className="flex h-14 items-center gap-2 font-semibold sm:border-b sm:border-border sm:px-4">
          <Mark />
          Lyra
        </div>
        <nav className="flex items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5 sm:p-2">
          {NAV.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
            >
              <Icon className="h-4 w-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
              {label}
            </a>
          ))}
        </nav>
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
            <ThemeToggle />
            <AccountMenu email={props.email} onLogout={props.onLogout} />
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-auto p-6">{props.children}</main>
      </div>
    </div>
  )
}
