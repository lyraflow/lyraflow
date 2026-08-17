import { CONTEXT_FIELDS } from '@lyraflow/core/segments/ast.js'
import type {
  Behavior,
  Context,
  FilterNode,
  Lifecycle,
  Trait,
} from '@lyraflow/core/segments/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import { AlertTriangle } from 'lucide-react'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { Label } from '../../components/ui/label.js'
import { BehaviourForm } from './BehaviourForm.js'
import { ContextForm } from './ContextForm.js'
import { LIFECYCLE_FIELDS, LifecycleForm } from './LifecycleForm.js'
import { TraitForm } from './TraitForm.js'
import { summarise } from './summarise.js'
import { incompleteAt, warningsAt } from './warnings.js'

/**
 * The four leaf kinds the AST defines, in the order the switcher offers
 * them, each with the label an OPERATOR sees. The labels are the operator's
 * vocabulary, not the AST's: "what they did" is the question the person
 * building a segment is actually asking, and `behavior` is the answer's
 * storage shape. The `kind` on the left is the only thing that ever reaches
 * a node.
 */
const LEAF_KINDS = [
  { kind: 'trait', label: 'who they are' },
  { kind: 'behavior', label: 'what they did' },
  { kind: 'context', label: 'where they came from' },
  { kind: 'lifecycle', label: 'lifecycle' },
] as const

type LeafKind = (typeof LEAF_KINDS)[number]['kind']

/** The window a fresh `behavior` starts with. Bounded rather than `ever`,
 * so a condition the operator has not finished writing cannot start out
 * scanning all history. */
const DEFAULT_WINDOW_DAYS = 30

/**
 * How a Negate toggle shows that it is ON -- shared by this component and by
 * `GroupCard`, which renders the same control for a whole group, because two
 * spellings of one affordance is how one of them stops being maintained.
 *
 * **It changes the FILL, not the border, and that is measured rather than
 * chosen.** This used to read `aria-pressed:border-foreground
 * aria-pressed:font-semibold`, and the border half was a no-op in both
 * themes: the `outline` variant's own `border` shorthand sets no colour, so
 * the border already resolves to `currentColor` -- which IS the foreground.
 * Computed `borderTopColor` was `rgb(18, 17, 16)` pressed and unpressed in
 * light, `rgb(242, 240, 236)` in both in dark. The whole affordance therefore
 * rested on a single font-weight step (600 against 500), which is just
 * perceptible side by side and not at all in isolation. Nobody noticed
 * because the `Not` badge rescues the leaf case and a sentence rescues the
 * group case.
 *
 * So: a filled button, whose computed `background-color` differs from the
 * unpressed one by the full distance between the two ends of the palette --
 * a difference no cascade accident can reduce to nothing, and one that does
 * not depend on `border` resolving to any particular value. The `hover:`
 * pair is not decoration either: `outline` carries `hover:bg-accent`, which
 * has exactly the same specificity as an `aria-pressed:` utility, so without
 * an `aria-pressed:hover:` of its own a pressed button would drop back to an
 * unpressed-looking fill the moment the pointer touched it.
 */
export const NEGATE_PRESSED =
  'aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:font-semibold aria-pressed:hover:bg-foreground/90 aria-pressed:hover:text-background'

/**
 * The node a switch to `kind` REPLACES the old one with -- a whole fresh
 * literal per kind, never a spread of what was there before. Same rule, and
 * the same reason, as `WindowPicker`'s own variant switch (that file's doc
 * comment): spreading would leave a `trait`'s `key` on a `context` node or a
 * `behavior`'s `window` on a `lifecycle` one, fields the AST's union would
 * refuse to parse back -- produced by this UI rather than by a hand-built
 * request. A partially-converted node is a shape the AST does not describe.
 *
 * **An empty field here means "not filled in yet", and that is the whole
 * rule.** The AST is a STORAGE schema; a half-typed condition is a
 * legitimate editing state and an illegitimate storage state, so this seeds
 * a DRAFT rather than a saveable node. An earlier version of this comment
 * said the opposite -- that every default had to be valid the instant it
 * existed -- and paying that bill is what made a fresh `trait` arrive with
 * `key: 'plan'` and a fresh `behavior` with `event: '*'`: data the operator
 * never chose, presented as though they had. The builder now refuses Save
 * while any condition is incomplete and says so on the row itself
 * (`completeness`/`incompleteAt`, `warnings.ts`), which is what makes an
 * honest blank affordable.
 *
 * So the split below is between a real CHOICE and a placeholder:
 *
 * - `key` (`trait`) and `event` (`behavior`) start EMPTY. They are the one
 *   thing only the operator can supply, and no value this file invents for
 *   them is more honest than saying nothing.
 * - Everything else is a real choice and stays one. `behavior` is `count`,
 *   the one aggregate that must carry NO `property` (`ast.ts`'s refine),
 *   over a bounded 30-day window -- never `ever`, so a condition the
 *   operator has not finished writing cannot start out scanning all
 *   history. `context`/`lifecycle` take their field from the enum that is
 *   the compiler's injection boundary -- `CONTEXT_FIELDS` from core,
 *   `LIFECYCLE_FIELDS` from `LifecycleForm` -- never a literal chosen here.
 *   `lifecycle` values must parse as datetimes, so it starts at `now`.
 * - None of them uses `between`, so the "exactly two values" half of
 *   `valueFor`'s refine is satisfied by construction.
 *
 * `event: '*'` deserves its own line, because it is legal and therefore
 * tempting: it parses, so it would keep the old rule. But it MEANS "any
 * event", which raises a cost warning of its own the instant the condition
 * appears and suppresses the automatic preview with it. A brand-new
 * condition nobody has finished writing must not arrive carrying a scary
 * warning about scanning everything. This file's tests pin that a fresh
 * behaviour raises no cost warning at all.
 */
function defaultLeaf(kind: LeafKind, now: Date): FilterNode {
  switch (kind) {
    case 'behavior':
      return {
        kind: 'behavior',
        event: '',
        aggregate: 'count',
        window: { kind: 'last', n: DEFAULT_WINDOW_DAYS, unit: 'days' },
        operator: '>=',
        value: 1,
      }
    case 'context':
      return {
        kind: 'context',
        field: CONTEXT_FIELDS[0],
        scope: 'latest',
        operator: '=',
        value: '',
      }
    case 'lifecycle':
      return {
        kind: 'lifecycle',
        field: LIFECYCLE_FIELDS[0],
        operator: '>=',
        // A zone-carrying instant, not the wall-clock reading this used to
        // seed. `Lifecycle`'s refine accepts either, and the picker now
        // displays either correctly (`datetime.ts`) -- but a bound WRITTEN by
        // this screen should say which instant it means, and a wall-clock
        // reading does not: the compiler resolves it in the server's zone.
        value: now.toISOString(),
      }
    default:
      return { kind: 'trait', key: '', operator: '=', value: '' }
  }
}

/**
 * The leaf renderer: dispatches on `node.kind` -- unwrapping a `not` first,
 * the same way `summarise` already does, so a negated leaf still shows the
 * real form for what it negates rather than falling back to plain text.
 * `trait`/`context`/`lifecycle` get their real per-kind forms, and
 * `behavior` gets `BehaviourForm` -- every leaf kind the AST
 * defines now has one. The `default` branch below is defensive only: it
 * stays reachable in the TYPE system (nothing here asserts exhaustiveness),
 * so a leaf kind added to the AST later without a matching form here still
 * renders the one-line `summarise` text instead of nothing at all.
 *
 * This component's actual job is the STRUCTURE
 * around whatever body renders: the `condition-<path>` testid the
 * recursion's own tests address nodes through at arbitrary depth, and
 * Remove/Negate, which this component NEVER computes a path for itself --
 * `path` and the three callbacks all come from the caller (`GroupCard`),
 * addressed to this node's own position. That is what keeps "negate the
 * wrong sibling" and "negate the parent instead of the node" unreachable
 * from here: there is no tree, no root, and no `path` maths in this file at
 * all, only the address it was handed.
 *
 * `onChange` replaces this node's own value wholesale (`replaceAt(root,
 * path, next)`, wired by `GroupCard`). A per-kind form's own `onChange`
 * only ever hands back the UNWRAPPED node it was given (a `Trait`, never a
 * `not`) -- `wrapLike` below re-applies this leaf's own negation before
 * forwarding to `props.onChange`, so a form component never has to know
 * whether the node it is editing is currently negated.
 *
 * `warnings` is the FULL `costWarnings()` list for the whole tree,
 * not pre-filtered by the caller -- `warningsAt` (own doc comment,
 * `warnings.ts`) picks out only the ones addressed to THIS node's own
 * `path`, rendered inside this component's own testid wrapper rather than
 * in a page-level panel. That is the whole point: "the `import_started`
 * condition scans all history" is actionable read against the row it
 * names; the same sentence in a panel above 40 conditions is not. Defaults
 * to `[]` so every existing caller (every test in this file, `GroupCard`'s
 * own recursion) keeps working unchanged.
 *
 * `incomplete` is the SAME arrangement for the other thing a row has to say
 * about itself: the full list of editor paths whose node does not parse
 * against the AST (`completeness`, `warnings.ts`), passed down unfiltered,
 * with `incompleteAt` picking out whether THIS row is one of them. A
 * page-level "something is not filled in" banner would be the exact "which
 * of 40 conditions is meant" problem the per-condition rendering exists to
 * avoid, and the answer is the one thing the operator needs. Defaults to
 * `[]`.
 *
 * The "Match on" select is what makes the other three kinds REACHABLE at
 * all: until it existed, `GroupCard`'s `newCondition()` hardcoded a `trait`
 * and nothing anywhere could change a condition's kind, so the behaviour
 * form -- the most valuable thing this screen can express -- could only be
 * reached by authoring the node through the CLI or API. Switching REPLACES
 * the node wholesale (`defaultLeaf` above), and `wrapLike` carries this
 * leaf's own negation across the switch, exactly as it does for an edit:
 * a `not` wraps a node rather than belonging to it, so changing what is
 * negated must never change WHETHER it is.
 *
 * `behaviorCap` is the one thing this component cannot work out for itself:
 * whether the tree as a whole has room for another `behavior` node
 * (`MAX_BEHAVIOR_NODES`, `validate.js`). There is no tree here --
 * deliberately, see above -- so `GroupCard`, which has `root`, computes it
 * through the same `capBlock` its own "Add condition" uses and hands the
 * answer down. What this component adds is the DIRECTION: the cap is
 * consulted only for a switch that would actually CREATE a behaviour, never
 * for one that removes one or leaves the count alone. Getting that backwards
 * is a real, previously-shipped defect in this screen (`capBlock`'s own doc
 * comment): a cap that refuses trees the server would accept traps the
 * operator with no route out short of the CLI -- here it would mean a
 * behaviour condition at the cap could not be switched to anything else.
 * Defaults to unblocked, so every existing caller keeps working unchanged.
 */
function wrapLike(original: FilterNode, next: FilterNode): FilterNode {
  return original.kind === 'not' ? { kind: 'not', child: next } : next
}

export function ConditionRow(props: {
  node: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
  onRemove: () => void
  onNegate: () => void
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
  warnings?: CostWarning[]
  incomplete?: number[][]
  behaviorCap?: { blocked: boolean; message: string }
}) {
  const {
    node,
    path,
    onChange,
    onRemove,
    onNegate,
    client,
    projectId,
    onUnauthorized,
    warnings = [],
    incomplete = [],
    behaviorCap = { blocked: false, message: '' },
  } = props
  const ownWarnings = warningsAt(warnings, path)
  // Recomputed from the tree on every render, never remembered -- which is
  // what keeps a kind switch from leaving the previous kind's message
  // standing over a condition that no longer has that problem.
  const notFinished = incompleteAt(incomplete, path)
  // Whether THIS node is currently negated -- drives `aria-pressed` AND
  // which node the per-kind form below actually edits (the one `node`
  // wraps, never the `not` itself). `onNegate` toggles it either way
  // regardless of the current state, so the accessible name stays "Negate"
  // rather than flipping to "Un-negate" and breaking a test (or a person)
  // that looked for the word "negate" after a toggle.
  const negated = node.kind === 'not'
  const inner = negated ? node.child : node
  const testId = `condition-${path.join('-')}`
  const kindId = `${testId}-kind`
  const handleChange = (next: FilterNode) => onChange(wrapLike(node, next))

  /**
   * Why a switch to `next` is refused, or `null` if it is allowed -- one
   * expression, read by all three things that must agree about it: the
   * `<option>`'s own `disabled`, the sentence below the control, and
   * `setKind`'s own refusal. Three renderings of one decision, not three
   * decisions.
   *
   * Both early returns are load-bearing and pinned separately (this file's
   * tests). The first keeps the behaviour cap from touching a switch that
   * creates no behaviour -- without it, a tree at the cap could not be
   * edited towards being legal at all. The second is the same rule for the
   * kind that is ALREADY a behaviour: switching it to itself adds nothing,
   * so its own option must not render disabled, which would show the
   * operator their current state as forbidden.
   */
  function switchRefusal(next: LeafKind): string | null {
    if (next !== 'behavior') return null
    if (inner.kind === 'behavior') return null
    return behaviorCap.blocked ? behaviorCap.message : null
  }

  const behaviorRefusal = switchRefusal('behavior')

  function setKind(next: LeafKind) {
    // Re-selecting the kind a node already has must not throw the node
    // away: `defaultLeaf` would replace an edited condition with a blank
    // one of the same kind. `WindowPicker`'s own `setKind` opens with the
    // same line for the same reason.
    //
    // NOT COVERED BY A TEST, and deliberately not given one that looks as
    // though it is: a `<select>` fires no `change` event for the value it
    // already holds, in a browser or under `fireEvent`, so removing this
    // line leaves the whole suite green. It guards the handler itself, not
    // a path the DOM can currently take to it.
    if (next === inner.kind) return
    // Not merely the `disabled` attribute below: an attribute is a hint to
    // a pointer, and a `change` event can arrive without one (keyboard, a
    // test, an assistive technology). The refusal has to live where the
    // node would actually be replaced.
    if (switchRefusal(next) != null) return
    handleChange(defaultLeaf(next, new Date()))
  }

  function body() {
    switch (inner.kind) {
      case 'trait':
        return (
          <TraitForm
            id={testId}
            node={inner as Trait}
            onChange={handleChange}
            client={client}
            projectId={projectId}
            onUnauthorized={onUnauthorized}
          />
        )
      case 'context':
        return <ContextForm id={testId} node={inner as Context} onChange={handleChange} />
      case 'lifecycle':
        return <LifecycleForm id={testId} node={inner as Lifecycle} onChange={handleChange} />
      case 'behavior':
        return (
          <BehaviourForm
            id={testId}
            node={inner as Behavior}
            client={client}
            projectId={projectId}
            onChange={handleChange}
            onUnauthorized={onUnauthorized}
          />
        )
      default:
        // Unreachable for any leaf kind the AST defines today -- every one
        // has a real form above. Kept as the one-line summary (computed on
        // `node`, not `inner`, so a negated leaf still reads "not (...)"
        // rather than dropping the negation from view) as a defensive
        // fallback for a future kind added here before it gets a form.
        return <span className="text-sm text-foreground">{summarise(node)}</span>
    }
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-md border border-border bg-background px-2 py-2 sm:px-3"
    >
      {/* THREE stacked rows -- kind, then body, then controls -- and none of
       * them shares a flex line with another. Never one wrapping row that
       * relies on `justify-between` plus a wrap to separate them, and never
       * the kind selector sharing a wrapping row with the body either.
       *
       * Both of those shapes put the result at the mercy of each per-kind
       * form's FLEX-BASIS, which is not something this component controls or
       * should have to know. `BehaviourForm`'s root used to carry `flex-1`
       * (`flex: 1 1 0%`), so its hypothetical width when a shared row decided
       * where to break was 0: it could never push a sibling onto a line of
       * its own. It absorbed the free space, sat beside whatever shared the
       * row, and -- being several rows tall against a one-row sibling --
       * `items-center` parked that sibling at exactly its vertical middle.
       *
       * **That is a defect this file has now shipped twice**, which is why
       * the rows are separated structurally rather than by an alignment
       * value. The first time it was Negate/Remove, and the fix moved them to
       * their own row -- but LEFT `items-center` on the body row, and left
       * this comment claiming the shape was fixed. The kind selector added
       * later inherited it verbatim: measured at 1180px, it rendered 302px
       * BELOW the top of its own condition, level with the behaviour's
       * `Where` block and beside a 200x660px empty column, reading as a label
       * on one of the condition's sub-parts rather than on the condition. The
       * width-dependence is what made it survive review: at 390px, or at
       * depth three, the form's min-content forces the break and the selector
       * sits correctly at the top.
       *
       * Note the measured trap in the obvious explanation: "the behaviour
       * form is narrower than the row" is true of the trait form too (480
       * of 598px at 1180px wide) and yet the trait's buttons still wrapped.
       * Width after layout does not predict the break; flex-basis does. So
       * the guarantee here is not "the alignment is right", it is that
       * nothing the four forms can do to their own flex-basis can reorder
       * these three rows -- each is a separate flex container, and the kind
       * selector is the first thing in the first one at every width and for
       * every leaf kind. */}
      <div className="flex flex-wrap items-end gap-2">
        {/* A negated leaf must SAY it is negated. `aria-pressed` on the
         * Negate button alone was invisible: the vendored Button has no
         * pressed styling, so `not (status = churned)` rendered
         * pixel-identical to `status = churned` -- an operator reads the
         * row as including exactly the people it excludes. `GroupCard`
         * already announces its own negation in words; only leaves were
         * silent. */}
        {negated && (
          <span className="mb-1.5 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            Not
          </span>
        )}
        {/* The FIRST control of every condition, because it decides what
         * every control after it means. Its labels are the operator's
         * question ("what they did"), never the AST's noun -- see
         * `LEAF_KINDS`. */}
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={kindId}>Match on</Label>
          <select
            id={kindId}
            aria-label="Match on"
            value={inner.kind}
            onChange={(e) => setKind(e.target.value as LeafKind)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
          >
            {LEAF_KINDS.map(({ kind, label }) => (
              <option key={kind} value={kind} disabled={switchRefusal(kind) != null}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {body()}
      {/* Said on the row it is about, never in a page-level banner -- the
       * same rule the cost warnings below follow, and for the same reason.
       * An operator who clicks "Add condition" and then Save gets a Save
       * button that is disabled; without this, nothing on screen says which
       * of their conditions is holding it down, or why. */}
      {notFinished && (
        <p className="text-xs text-muted-foreground">
          This condition is not finished. Fill in its remaining fields before saving.
        </p>
      )}
      {/* Said, not merely refused -- the same treatment "Add condition"
       * gives a cap it is blocked by, and for the same reason: a control
       * that is disabled with no sentence beside it is indistinguishable
       * from one that is broken. */}
      {behaviorRefusal != null && (
        <p className="text-xs text-muted-foreground">{behaviorRefusal}</p>
      )}
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={negated}
          className={NEGATE_PRESSED}
          onClick={onNegate}
        >
          Negate
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {ownWarnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {ownWarnings.map((w, i) => (
            <li key={`${w.path}-${i}`} className="flex items-start gap-1.5 text-xs text-foreground">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span>{w.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
