import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils.js'
import { Input } from './ui/input.js'

/**
 * The suggestion field every name/value box in the builder is made of.
 *
 * ## Why this is not `<input list>` + `<datalist>`
 *
 * It used to be, and the native control cannot do the one thing this field
 * is for. A `<datalist>` opens when the BROWSER decides -- typically only
 * once a few characters have been typed -- and there is no API to open it,
 * so "show me what exists before I type" is unreachable. An operator who
 * does not already know their event names is exactly the operator a picker
 * is for; one that first demands the answer's opening letters is not a
 * picker at all. The native element is also unstyleable, so an empty list
 * cannot say WHY it is empty.
 *
 * So the popup is built here: a real `role="listbox"`, opened on focus,
 * showing whatever the owner has fetched.
 *
 * ## What it deliberately does NOT do
 *
 *  - **It never filters.** `options` (or `groups`) is rendered verbatim.
 *    Filtering is a prefix match owned by the caller -- a debounced
 *    server-side `startsWith` for the lists that come from ClickHouse, a
 *    local one for the fixed list of event columns -- and re-filtering the
 *    answer here would silently apply a second, different rule to a list
 *    that has already been narrowed.
 *  - **It never fetches.** When and how eagerly a list may be asked for
 *    depends entirely on what is behind it -- a catalogue read is cheap and
 *    happens on mount, a partition scan is not and waits for a focus. The
 *    owner decides; this component only reports interaction through
 *    `onInteract`.
 *  - **It never closes the field.** A typed name absent from `options` is
 *    accepted unchanged -- a definition may legitimately be written ahead of
 *    the data that fills it. The list is a help, never a whitelist.
 *
 * ## The popup is portalled, and that is load-bearing
 *
 * `Shell` renders `<main class="overflow-auto">` inside a fixed `h-dvh`
 * shell, and a condition sits inside bordered cards nested several levels
 * deep. A popup in normal flow is clipped by the first of those ancestors
 * with a scroll container -- and the deeper the condition, the more certain
 * that is. So it renders into `document.body` with `position: fixed`,
 * measured off the field's own box on open and re-measured on scroll and
 * resize. `fixed` is what makes an ancestor's `overflow` irrelevant;
 * re-measuring is what keeps it attached to a field that moved.
 */

/** Below this much room under the field, the popup opens upwards instead.
 * A list shorter than roughly three rows is not worth reading. */
const FLIP_THRESHOLD_PX = 160
/** As tall as the popup ever gets; it scrolls beyond this. */
const MAX_POPUP_PX = 288
/** Between the field and the popup, and between the popup and the viewport
 * edge it is clamped against. */
const GAP_PX = 4
/** A popup narrower than this cannot show a name, however narrow the field
 * that owns it is (a `between` bound at 390px is ~100px wide). */
const MIN_POPUP_PX = 200

type Placement =
  | { side: 'below'; top: number; left: number; width: number; maxHeight: number }
  | { side: 'above'; bottom: number; left: number; width: number; maxHeight: number }

export function Combobox(props: {
  /** The input's DOM id, so a `<Label htmlFor>` can point at it. */
  id?: string
  /** The accessible name. Rendered as `aria-label`; pass the same text the
   * visible `<Label>` carries. */
  label: string
  value: string
  /** `group` is the label of the section a row was chosen from, and is
   * undefined for text the operator typed. A caller with no `groups` can
   * ignore it entirely. */
  onChange: (next: string, group?: string) => void
  /** Rendered verbatim, in order. Already filtered by whoever fetched them.
   * Ignored when `groups` is given. */
  options: string[]
  /**
   * Sectioned options, rendered with a heading above each section, in the
   * order given. When present this REPLACES `options` -- a caller has one
   * list or the other, never both.
   *
   * Selection stays flat: `active`, ArrowUp/ArrowDown and Enter walk the
   * concatenation of every section's options and skip the headings, which
   * is what the ARIA listbox pattern requires (a heading is not an option
   * and must not be reachable as one).
   *
   * `onChange`'s second argument names the section a row was CHOSEN from,
   * and is the only reason this exists rather than the caller flattening
   * the list itself: two sections may legitimately offer the same name --
   * an event property called `path` and the event column called `path` --
   * and which was picked is a fact only this component holds.
   */
  groups?: { label: string; options: string[] }[]
  /** Called with this box's current text when the popup opens and on every
   * keystroke -- the hook a caller whose lookup is on-demand hangs its fetch
   * on. A caller that fetches eagerly needs none. */
  onInteract?: (text: string) => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'datetime-local'
  /** Extra classes for the wrapper that anchors the popup, not the input. */
  className?: string
  /** True while no lookup has answered yet. Keeps the popup from asserting
   * an absence it has no evidence for -- "none recorded" and "not asked yet"
   * look identical from an empty array. */
  loading?: boolean
  /** What an EMPTY answer to an unfiltered lookup means, in the caller's own
   * words ("No traits recorded yet -- they appear here once your app calls
   * identify()"). Only used when the box is empty, because with text in it
   * the reason is the prefix filter and this component already knows how to
   * say that. */
  emptyMessage?: string
  /** Said INSTEAD of any empty-state message when the lookup itself failed.
   * A failed request is no evidence about whether names exist, so stacking
   * "could not load" with "none recorded" would assert something nothing
   * has established. It lives in the popup because that is where the
   * operator is looking when they find the list empty. */
  errorMessage?: string
}) {
  const {
    id: idProp,
    label,
    value,
    onChange,
    options,
    groups,
    onInteract,
    placeholder,
    disabled,
    type = 'text',
    className,
    loading = false,
    emptyMessage,
    errorMessage,
  } = props

  const generatedId = useId()
  const id = idProp ?? generatedId
  const listId = `${generatedId}-listbox`

  // What the keyboard walks. Sections are a rendering concern only: every
  // index below -- `active`, `aria-activedescendant`, the option ids -- is
  // an index into THIS array, so the two modes share one selection model
  // and a heading can never become the active descendant.
  const rows: { option: string; group?: string }[] = groups
    ? groups.flatMap((g) => g.options.map((option) => ({ option, group: g.label })))
    : options.map((option) => ({ option }))

  const [open, setOpen] = useState(false)
  // -1 is "no option is active", and it is the state a freshly opened popup
  // is in unless the box already holds one of the names. Enter must then do
  // nothing rather than take the first row: the operator who focuses a field
  // and presses Enter is submitting, not choosing, and a picker that quietly
  // rewrites their value for that is worse than one that never opened.
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const anchorRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const measure = useCallback(() => {
    const el = anchorRef.current
    if (el == null) return
    const box = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    const below = vh - box.bottom - GAP_PX
    const above = box.top - GAP_PX
    // Flip only when staying put would be genuinely unusable AND turning
    // round is actually better. Near the bottom of a long tree that is the
    // normal case; in the middle of the screen it never fires.
    const side: 'below' | 'above' = below < FLIP_THRESHOLD_PX && above > below ? 'above' : 'below'
    const room = side === 'above' ? above : below
    const maxHeight = Math.max(0, Math.min(MAX_POPUP_PX, room))
    const width = Math.min(Math.max(box.width, MIN_POPUP_PX), Math.max(0, vw - 2 * GAP_PX))
    // Clamped against the right edge as well as the left: widened to
    // MIN_POPUP_PX, a narrow field near the right margin would otherwise
    // hang off the viewport and give the page horizontal scroll.
    const left = Math.min(Math.max(GAP_PX, box.left), Math.max(GAP_PX, vw - width - GAP_PX))
    setPlacement(
      side === 'below'
        ? { side, top: box.bottom + GAP_PX, left, width, maxHeight }
        : // Anchored by its BOTTOM edge, so the popup does not have to be
          // measured before it can be placed -- it grows upwards from the
          // field however many rows it ends up with.
          { side, bottom: vh - box.top + GAP_PX, left, width, maxHeight },
    )
  }, [])

  // Before paint, so the popup is never shown at a stale position for a frame.
  useLayoutEffect(() => {
    if (!open) return
    measure()
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => measure()
    // `capture: true` is the whole point of the scroll listener: scroll does
    // not bubble, and the element that actually scrolls here is `main`, not
    // the window. Without capture, scrolling the builder would leave the
    // popup behind at the position the field used to be in.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, measure])

  // Closing on a click elsewhere, and on Tab, is `onBlur`'s job and nothing
  // else's. A document-level `mousedown` listener was written here first and
  // deleted: with the popup's own `mousedown` defaulted away (below), every
  // click that is not inside this field blurs the input, so the listener
  // could not be made to fail a test on its own -- it was a second
  // implementation of one rule, and the kind that rots because nothing
  // exercises it.

  // A shorter answer must not leave the highlight pointing past the end of
  // the list -- `aria-activedescendant` would then name an id that no longer
  // exists, which a screen reader reports as nothing at all.
  useEffect(() => {
    setActive((current) => (current >= rows.length ? rows.length - 1 : current))
  }, [rows.length])

  // Keeps the highlighted row on screen once the list is taller than the
  // popup. Guarded because jsdom implements no scrolling at all.
  useEffect(() => {
    if (!open || active < 0) return
    // By id, not by child index: with sections the popup's children are
    // headings and options interleaved, so `children[active]` would scroll
    // to whatever happens to sit at that position. `useId` values contain
    // colons, which `querySelector` would reject as a selector.
    const el = document.getElementById(`${listId}-option-${active}`)
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  // No `if (disabled) return` here: every route into this function --
  // `onFocus`, `onClick`, ArrowUp/ArrowDown -- needs an enabled input to
  // fire at all, so the native `disabled` attribute IS the guard. A check
  // here could not be made to fail a test, which is how it was found to be
  // decoration rather than protection.
  function openPopup(text: string) {
    setOpen(true)
    // The row already in the box, if it is one of them. Nothing otherwise --
    // see the `active` declaration.
    setActive(rows.findIndex((r) => r.option === text))
    onInteract?.(text)
  }

  // No `focus()` call here, deliberately: the popup's `onMouseDown`
  // `preventDefault` means focus never left the input, and re-focusing an
  // already-focused element fires nothing -- whereas focusing one that HAD
  // lost focus would run `onFocus` and re-open the popup the operator just
  // closed by choosing from it.
  function commit(next: string, group?: string) {
    // The second argument is passed only when there IS one. A flat-list
    // caller's `onChange` then sees exactly the one-argument call it has
    // always seen -- invisible to the callers themselves, but not to a test
    // asserting on the call, and not worth changing for three consumers
    // that have no sections.
    if (group === undefined) onChange(next)
    else onChange(next, group)
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        openPopup(value)
        return
      }
      setActive((i) => (rows.length === 0 ? -1 : (i + 1) % rows.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openPopup(value)
        return
      }
      setActive((i) => (rows.length === 0 ? -1 : (i <= 0 ? rows.length : i) - 1))
      return
    }
    if (e.key === 'Enter') {
      const chosen = active >= 0 ? rows[active] : undefined
      if (open && chosen !== undefined) {
        // Only swallowed when it actually chose something: an Enter that
        // selects nothing must still reach whatever the field is inside.
        e.preventDefault()
        commit(chosen.option, chosen.group)
      }
      return
    }
    if (e.key === 'Escape') {
      if (!open) return
      // Deliberately no `onChange`: Escape abandons the list, not the text.
      e.preventDefault()
      setOpen(false)
      setActive(-1)
      return
    }
    // Tab is deliberately absent. It is not prevented, so focus moves on and
    // `onBlur` closes the popup, keeping whatever was typed -- exactly what
    // a click elsewhere does. A `Tab` branch here was written first and
    // deleted for the same reason as the document listener above: removing
    // it failed nothing, because `onBlur` had already done the work.
  }

  const emptyText = loading
    ? 'Looking…'
    : value.trim() !== ''
      ? `Nothing recorded starts with “${value.trim()}”. You can still use it.`
      : (emptyMessage ?? 'Nothing recorded yet. You can still type a name.')

  const popup =
    open && placement !== null
      ? createPortal(
          // biome-ignore lint/a11y/useFocusableInteractive: deliberate, and required by the ARIA combobox pattern. Focus stays on the input; the active option is named by aria-activedescendant, which is what a screen reader follows. Making the list focusable would take focus off the text the operator is typing.
          <div
            ref={listRef}
            id={listId}
            // biome-ignore lint/a11y/useSemanticElements: the semantic element biome offers for this role is <select>, which is the one thing this popup must never become -- every name here stays free-typed.
            role="listbox"
            // Deliberately NOT derived from `label`. The popup is reached
            // through the combobox, which already carries the field's name,
            // so naming it "Event suggestions" adds nothing a screen reader
            // needs -- and it puts a SECOND element carrying the word
            // "Event" into the accessible tree, which makes an
            // accessible-name query for the field itself ambiguous the
            // moment the popup is open. One field, one name.
            aria-label="Suggestions"
            // Every mousedown anywhere in this popup is defaulted away, and
            // that one line carries three things. It keeps focus in the
            // input, so choosing a row does not blur the field out from
            // under the click that is still arriving (the classic "clicking
            // a suggestion does nothing"); it lets the popup's own scrollbar
            // be dragged without the list closing; and, because everything
            // else on the page therefore DOES blur the input, it is what
            // makes `onBlur` a complete close rule on its own.
            onMouseDown={(e) => e.preventDefault()}
            style={{
              position: 'fixed',
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.side === 'below'
                ? { top: placement.top }
                : { bottom: placement.bottom }),
            }}
            className="z-50 overflow-y-auto overflow-x-hidden rounded-md border border-border bg-popover py-1 text-sm text-foreground shadow-md"
          >
            {rows.length === 0 && errorMessage !== undefined ? (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {errorMessage}
              </p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</p>
            ) : (
              rows.map((row, i) => (
                /* A heading is emitted BEFORE the first row of its section
                 * rather than as a row of its own, so the list stays a flat
                 * sequence of `role="option"` children with nothing
                 * unselectable interleaved into the index space. `aria-hidden`
                 * because the grouping is announced by `aria-label` on the
                 * options' own container in every browser that supports it,
                 * and a bare text node inside a listbox is read as an option
                 * that cannot be chosen in the ones that do not. */
                <Fragment key={`${row.group ?? ''}:${row.option}`}>
                  {row.group !== undefined && row.group !== rows[i - 1]?.group && (
                    <p
                      aria-hidden="true"
                      className="px-3 pt-2 pb-1 font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-wide first:pt-1"
                    >
                      {row.group}
                    </p>
                  )}
                  {/* biome-ignore lint/a11y/useFocusableInteractive: same as the listbox above -- aria-activedescendant, not focus, is what moves through these rows. */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path for choosing a row is ArrowUp/ArrowDown/Enter on the combobox itself, where the ARIA pattern puts it. Focus never reaches this element, so a key handler on it could not fire. */}
                  <div
                    id={`${listId}-option-${i}`}
                    // biome-ignore lint/a11y/useSemanticElements: <option> is only meaningful inside <select>/<datalist>; this list exists precisely because neither can be opened on demand or styled.
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => commit(row.option, row.group)}
                    className={cn(
                      'cursor-pointer truncate px-3 py-1.5',
                      i === active && 'bg-accent',
                    )}
                  >
                    {row.option}
                  </div>
                </Fragment>
              ))
            )}
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={anchorRef} className={cn('relative min-w-0', className)}>
      <Input
        ref={inputRef}
        id={id}
        type={type}
        // `role="combobox"` is explicit, not inherited: an `<input list=…>`
        // computed this role for free, and both this app's tests and a
        // screen-reader user depend on it. Nothing about the field's
        // accessible name or role changed when the datalist went away.
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-option-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => openPopup(value)}
        // Focus alone is not enough: Escape closes the popup without moving
        // focus, so the only way back in for a mouse user is a click on a
        // field that is already focused -- which fires no focus event.
        onClick={() => {
          if (!open) openPopup(value)
        }}
        onBlur={() => {
          setOpen(false)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const next = e.target.value
          if (!open) setOpen(true)
          // A new answer is coming; whatever was highlighted was highlighted
          // in a list that is about to be replaced.
          setActive(-1)
          onChange(next)
          onInteract?.(next)
        }}
      />
      {popup}
    </div>
  )
}
