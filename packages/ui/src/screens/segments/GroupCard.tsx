import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { Label } from '../../components/ui/label.js'
import { ConditionRow, NEGATE_PRESSED } from './ConditionRow.js'
import {
  countBehaviours,
  countNodes,
  insertAt,
  negateAt,
  nodeAt,
  removeAt,
  replaceAt,
} from './tree.js'

/** A new, empty leaf inserted by "Add condition" -- an incomplete DRAFT,
 * deliberately. An empty `key` means "not filled in yet"; the builder holds
 * the draft, refuses Save while it stands, and the row says so itself
 * (`ConditionRow`'s own `defaultLeaf` doc comment has the full rule). This
 * is not a node the server would accept, and it is not meant to be: the
 * alternative is seeding a plausible key the operator never chose. */
export function newCondition(): FilterNode {
  return { kind: 'trait', key: '', operator: '=', value: '' }
}

/**
 * A new nested group inserted by "Add group" -- seeded with ONE default
 * condition (the same one `newCondition` inserts), never empty.
 *
 * A group with zero children is not
 * a state this editor should be able to produce. `removeAt` collapses a
 * group emptied BY REMOVAL, but nothing stopped one being BORN empty --
 * "Add group" used to insert `{ children: [] }`, which is invalid the
 * instant it exists (the AST's `children.min(1)`), before the operator has
 * done anything. The server's own rejection at save time was not an
 * adequate backstop for that: it is a guard that fires after the fact, not
 * a rule that keeps the state unreachable. Seeding with `newCondition()`
 * makes it unreachable instead, and keeps "Add condition" and "Add group"
 * agreeing on what a freshly-added condition looks like.
 *
 * Note what this is NOT saying, now that a freshly-added condition is
 * itself an incomplete draft. A blank `key` is a field the operator has not
 * reached yet, and the editor is the right place to hold it; an empty
 * `children` array is a SHAPE nothing in this editor should ever be able to
 * produce, and no amount of typing turns it into a segment. The first is a
 * state to render honestly and refuse to save; the second is a state to
 * make unreachable.
 *
 * `SegmentBuilder`'s empty-root save-disable
 * remains the backstop for the one empty-group state that IS still
 * reachable: removing the root's last remaining condition, which
 * `removeAt` deliberately leaves as an empty root rather than collapsing.
 */
function newGroup(): FilterNode {
  return { kind: 'group', op: 'and', children: [newCondition()] }
}

/**
 * How each join mode is named to a person -- read TWICE in this file, by the
 * "Match" select at the top of the card and by the sentence above the card's
 * own "Add" controls, and deliberately the same strings in both places.
 *
 * That identity is the whole mechanism: stacked "Add condition"/"Add group"
 * pairs at the bottom of a nest differ only by an indent step (35px against a
 * ~110px button), and no border or tint can carry the difference -- every
 * surface in this palette sits within ~1.1:1 of its neighbours by design, and
 * indentation was just REDUCED below `sm` to stop nested fields being clipped.
 * Words can: repeating the group's own header phrase beside its Add controls
 * is legible at the text contrast the palette already guarantees, and the
 * operator matches it by reading rather than by tracing a rail upwards.
 *
 * `and`/`or` are the AST's own values (`Group['op']`), so nothing here is a
 * second spelling of a stored value.
 */
const MATCH_LABELS: Record<Group['op'], string> = {
  and: 'all conditions (AND)',
  or: 'any condition (OR)',
}

/**
 * Which group a set of "Add" controls acts on, in words.
 *
 * The root is named rather than merely described, because "which group did
 * that add to" is asked most often about the outermost pair -- the one at the
 * very bottom of the page, furthest from the header it belongs to.
 */
function addLabel(isRoot: boolean, op: Group['op']): string {
  const which = isRoot ? 'the top-level group' : 'this group'
  return `Add to ${which}: ${MATCH_LABELS[op]}`
}

/** Whether a control is blocked by one of the three server-side caps
 * (`packages/core/src/segments/validate.js`), and which one -- so the
 * button can say what it's waiting on rather than merely refuse.
 *
 * `extraNodes`/`extraDepth`/`extraBehaviors` are how many nodes, how many
 * levels deeper than THIS group's own `depth`, and how many `behavior`
 * nodes the control being checked would add. "Add condition" inserts one
 * leaf one level below this group (1, 1); "Add group" inserts a group AND
 * the one condition it is seeded with -- never empty, `newGroup`'s own doc
 * comment -- so it costs two nodes, and its seeded child sits two levels
 * below this group, not one (2, 2). Checking the deeper of a control's own
 * two new nodes against `MAX_TREE_DEPTH` is sufficient: the shallower one
 * can never be the one that first exceeds the cap, since it is strictly
 * less deep.
 *
 * Node and behaviour counts are GLOBAL -- adding anywhere in the tree
 * consumes the same shared budget, so every `GroupCard` at every depth
 * checks the same `nodeCount`/`behaviorCount` computed from the whole
 * `root`, not its own subtree. Depth is LOCAL -- a group nine levels down
 * one branch does not cap a group two levels down another -- so it is
 * checked against `depth` (this group's own `path.length`), not
 * `maxDepth(root)`.
 *
 * `extraBehaviors` is still 0 from the two "Add" call sites below, and that
 * is deliberate, not an oversight: `newCondition()` and `newGroup()` both
 * hardcode a `trait` leaf, so neither control can ever itself create a
 * `behavior` node. Gating on the tree's EXISTING `behaviorCount` alone
 * (replacing an earlier version of this function that did exactly that)
 * would block "Add condition"/"Add group" on a tree the server would
 * happily accept the trait into -- the caps exist to stop the server
 * rejecting a tree the operator built, not the other way round.
 *
 * The THIRD call site is the one that finally passes `1`: the kind switcher
 * on each child `ConditionRow`, for the single switch that can create a
 * behaviour where there was none. It passes `0` extra nodes and `0` extra
 * depth because a switch replaces one leaf with one leaf, in place -- it
 * costs neither. Which switches consult the answer at all is
 * `ConditionRow`'s own decision (its `switchRefusal`), and has to be: this
 * component knows how many behaviours the tree holds, and only the row
 * knows whether the leaf being switched is one of them. Handing the row a
 * blanket "the cap is reached" instead would recreate the inverted gate
 * described above one level down -- a behaviour condition at the cap that
 * cannot be switched to a trait is a tree the server would accept, refused
 * by its own editor.
 */
function capBlock(
  nodeCount: number,
  behaviorCount: number,
  depth: number,
  extraNodes: number,
  extraDepth: number,
  extraBehaviors: number,
): { blocked: boolean; message: string } {
  if (nodeCount + extraNodes > MAX_TREE_NODES) {
    return {
      blocked: true,
      message: `Adding here would bring this segment to ${nodeCount + extraNodes} conditions; the maximum is ${MAX_TREE_NODES}.`,
    }
  }
  if (depth + extraDepth >= MAX_TREE_DEPTH) {
    return {
      blocked: true,
      message: `Adding here would nest a condition ${depth + extraDepth} levels deep; segments allow at most ${MAX_TREE_DEPTH}.`,
    }
  }
  if (behaviorCount + extraBehaviors > MAX_BEHAVIOR_NODES) {
    return {
      blocked: true,
      message: `Adding here would bring this segment to ${behaviorCount + extraBehaviors} behavioural conditions; the maximum is ${MAX_BEHAVIOR_NODES}.`,
    }
  }
  return { blocked: false, message: '' }
}

/**
 * Renders the group addressed by `path` inside `root` as a card: a
 * "Match" operator select, its children (each a nested `GroupCard` or a
 * `ConditionRow`), and controls to add a condition or a nested group.
 *
 * **Children are keyed BY POSITION, and that is a known limitation rather
 * than a design.** `childPath` is this group's own path with the child's
 * array index appended, so the key is the array index with a prefix on it:
 * after a removal or a reorder, `key="1-0"` belongs to whatever node now
 * sits at that position, and React reuses the previous occupant's component
 * instance for it. A key that made the instance follow the NODE would need a
 * per-node identity the AST does not carry -- nothing in a `FilterNode`
 * survives an edit, and this component would have to mint and store ids
 * itself.
 *
 * What makes it tolerable is that there is almost no instance-local state
 * below here to mis-associate: every form is fully CONTROLLED, rendering
 * from the node it is handed on every render, so a reused instance shows the
 * right node's values as soon as it re-renders with them. The known
 * exceptions are the two comboboxes -- `PropertyCombobox` and, under a
 * `behavior` leaf, `EventCombobox` -- which mirror their value into local
 * `text` state and re-sync it in an effect: after a removal each paints the
 * removed sibling's name for one commit before correcting itself.
 * `WherePredicates` keys its own rows the same way with the same component
 * beneath it. Anything added below here that holds state a re-render cannot
 * correct -- an uncommitted draft, a focus/selection position, an animation
 * -- makes this a real defect and needs the identity fixed first.
 *
 * Independently of the key: every handler below is created fresh inside this
 * render's `.map` callback, closing over `childPath` computed THIS render
 * -- never a path captured once and reused across renders -- and every one
 * calls a `tree.ts` function against the FULL `root` and hands the whole
 * new root to `onChange`. This component never edits `group` or a child in
 * place.
 *
 * `path` addresses this group's own position, which may hold the group
 * directly or a `not` wrapping it (legal input -- e.g. a CLI-authored
 * segment with a negated subgroup). `group` is unwrapped from that for
 * rendering, and `negated` records it. A negated group's own "Add" controls
 * are disabled: `insertAt`'s `path` must resolve to a `group` directly, and
 * a `not` is never a valid insert target (tree.ts's own doc on `insertAt`)
 * -- there is no path that addresses "the group inside this `not`" as its
 * own terminal target, because a `not` never consumes a path segment. The
 * only way to add a child here is to turn negation off first, which the
 * Negate control right beside the disabled ones does.
 *
 * `client`/`projectId`/`onUnauthorized` are threaded through, unused by this
 * component itself, purely to reach `BehaviourForm` at whatever
 * depth a `behavior` leaf sits -- the same reason `StepRows` threads them to
 * `EventCombobox` in the funnels builder.
 *
 * This also adds the three server-side caps (`MAX_TREE_NODES`,
 * `MAX_TREE_DEPTH`, `MAX_BEHAVIOR_NODES`, all from
 * `packages/core/src/segments/validate.js`) as a DISABLE here, computed
 * fresh on every render from `root` -- see `capBlock`'s own doc comment for
 * why node/behaviour counts are global but depth is local to this group,
 * and why the behaviour cap is parameterised on how many behaviours THIS
 * control would add (0 for both "Add" buttons, 1 for the kind switcher on a
 * child row) rather than on the tree's existing count.
 */
export function GroupCard(props: {
  root: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
  /** The whole tree's `costWarnings()` list, passed through
   * unfiltered at every level -- only `ConditionRow`, at the leaf a warning
   * actually names, picks its own out via `warningsAt`. Defaults to `[]` so
   * every caller from before this (this file's own tests included)
   * keeps working unchanged. */
  warnings?: CostWarning[]
  /** The whole tree's incomplete-node paths (`completeness`,
   * `warnings.ts`), threaded through at every level exactly like
   * `warnings` above and filtered nowhere but at the leaf, by
   * `ConditionRow`'s own `incompleteAt`. Defaults to `[]`. */
  incomplete?: number[][]
}) {
  const {
    root,
    path,
    onChange,
    client,
    projectId,
    onUnauthorized,
    warnings = [],
    incomplete = [],
  } = props
  const node = nodeAt(root, path)
  // Defensive only -- every caller of GroupCard (TreeEditor for the root,
  // this component for a nested group) resolves `path` from the tree it is
  // currently rendering, so it always resolves. Renders nothing rather
  // than throwing if it somehow doesn't.
  if (node == null) return null
  const negated = node.kind === 'not'
  const group = (negated ? node.child : node) as Group
  const isRoot = path.length === 0
  const testId = `group-${path.join('-')}`
  const matchId = `${testId}-match`
  // Scoped to this group's own path, like every other id in this tree: a
  // flat literal would have every group's buttons describing the ROOT's
  // label, which is the exact confusion this is here to remove.
  const addLabelId = `${testId}-add-label`

  // Global counts (the whole tree shares one budget for these), local depth
  // (this group's own position) -- see `capBlock`'s own doc comment.
  const nodeCount = countNodes(root)
  const behaviorCount = countBehaviours(root)
  const depth = path.length
  // extraBehaviors is 0 for both -- see capBlock's own doc comment on why
  // that is deliberate, not a gap: neither control can create a
  // `behavior` node today.
  const conditionCap = capBlock(nodeCount, behaviorCount, depth, 1, 1, 0)
  const groupCap = capBlock(nodeCount, behaviorCount, depth, 2, 2, 0)
  // What a child row's kind switcher would cost if the operator chose
  // "what they did" on a leaf that is not already one: one more behaviour,
  // no more nodes, no more depth. Whether a given row consults this at all
  // is that row's own call -- see `capBlock`'s doc comment.
  const behaviorSwitchCap = capBlock(nodeCount, behaviorCount, depth, 0, 0, 1)

  function setOp(op: 'and' | 'or') {
    const nextGroup: Group = { ...group, op }
    onChange(replaceAt(root, path, negated ? { kind: 'not', child: nextGroup } : nextGroup))
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-2 sm:p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={matchId}>Match</Label>
        <select
          id={matchId}
          aria-label="Match"
          value={group.op}
          onChange={(e) => setOp(e.target.value as 'and' | 'or')}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          {/* From `MATCH_LABELS`, which the Add controls' own sentence below
           * reads as well -- see that record's doc comment for why the two
           * have to be the same words rather than merely mean the same. */}
          <option value="and">{MATCH_LABELS.and}</option>
          <option value="or">{MATCH_LABELS.or}</option>
        </select>

        {/* The root is never removable (tree.ts's removeAt rejects
         * `path === []` outright) and, after TreeEditor's normalisation,
         * never negated either -- a non-group root gets wrapped INTO a
         * fresh group rather than the root itself ever being a `not`. So
         * these controls only make sense, and only render, below the
         * root. */}
        {!isRoot && (
          // `data-testid` here, not just accessible names, because these
          // buttons live INSIDE the same card as every descendant leaf's
          // own Remove/Negate (ConditionRow) -- `within(card).getByRole(
          // 'button', { name: /negate/i })` is ambiguous the moment a card
          // has any children, since the leaf's button matches the same
          // regex. Scoping a query to this wrapper's testid, not the whole
          // card, is what disambiguates "this group's own control" from
          // "some descendant's".
          <div className="ml-auto flex gap-1" data-testid={`${testId}-controls`}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={negated}
              className={NEGATE_PRESSED}
              onClick={() => onChange(negateAt(root, path))}
            >
              Negate
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(removeAt(root, path))}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      {negated && (
        <p className="text-xs text-muted-foreground">
          This group is negated. Turn Negate off to add or edit its conditions.
        </p>
      )}

      {/* Depth is signalled GEOMETRICALLY -- rail width and indent -- not by
       * fill. Every surface in this palette sits within ~1.1:1 of its
       * neighbours by design, so tinting nested cards differently would be
       * a change no one can see; indentation has no contrast requirement
       * and is the only lever that actually reads at depth three.
       *
       * **The indent is narrower on a phone, and that is a measured
       * trade rather than a taste.** Rail plus indent plus card padding cost
       * 35px per level at `pl-5`, so a depth-three condition started 105px in
       * -- 27% of a 390px viewport spent before the condition got any width
       * at all, which is most of why its fields were being clipped. `pl-2`
       * below `sm` gives 24px of that back per branch. Depth stays legible
       * because the rail is what carries it; the indent only has to be enough
       * to separate the rail from the content.
       *
       * The card's own `p-2 sm:p-3` above is the same trade for the same
       * reason, and it is not cosmetic either: card padding is paid twice per
       * level, and the last of it buys the difference between a native
       * date-and-time control showing `06/01/2026, 12:00 AM` and showing
       * `06/01/2026, 12:00 ` with the AM/PM clipped off. Below `sm` the
       * primitives also render at `text-base` rather than `text-sm`, so the
       * same string needs more room there than it does on a desktop. */}
      <div className="flex flex-col gap-3 border-l-2 border-border pl-2 sm:pl-5">
        {group.children.map((child, i) => {
          const childPath = [...path, i]
          const key = childPath.join('-')
          const inner = child.kind === 'not' ? child.child : child
          if (inner.kind === 'group') {
            return (
              <GroupCard
                key={key}
                root={root}
                path={childPath}
                onChange={onChange}
                client={client}
                projectId={projectId}
                onUnauthorized={onUnauthorized}
                warnings={warnings}
                incomplete={incomplete}
              />
            )
          }
          return (
            <ConditionRow
              key={key}
              node={child}
              path={childPath}
              onChange={(next) => onChange(replaceAt(root, childPath, next))}
              onRemove={() => onChange(removeAt(root, childPath))}
              onNegate={() => onChange(negateAt(root, childPath))}
              client={client}
              projectId={projectId}
              onUnauthorized={onUnauthorized}
              warnings={warnings}
              incomplete={incomplete}
              behaviorCap={behaviorSwitchCap}
            />
          )
        })}
      </div>

      {/* `data-testid` here, same reasoning as `${testId}-controls` above:
       * a nested group's OWN "Add condition"/"Add group" render inside
       * this card too (as part of a child `GroupCard`), so an unscoped
       * `getByRole('button', { name: /add condition/i })` against the
       * whole document -- or even against this card alone, once it has
       * any nested-group child -- is ambiguous the moment there is more
       * than one group in the tree. Scoping to this wrapper's own testid
       * disambiguates "this group's own Add controls" from a
       * descendant's. */}
      <div className="flex flex-col gap-1" data-testid={`${testId}-add`}>
        <div className="flex flex-wrap items-center gap-2">
          {/* WHICH group these two controls add to, said in words -- the one
           * thing that reads at depth three (see `MATCH_LABELS`). On the same
           * flex line as the buttons rather than above them, so the eye lands
           * on the words at the same height as the pair they belong to; it
           * wraps onto its own line when there is no room, which is the width
           * where the buttons are nearly the only thing on the line anyway.
           *
           * Tied to both buttons with `aria-describedby` as well as by
           * position: read aloud, "Add condition" alone has exactly the
           * ambiguity this fixes, and the accessible NAME is left untouched
           * (several suites address these buttons by it). */}
          <span id={addLabelId} className="text-xs text-muted-foreground">
            {addLabel(isRoot, group.op)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={addLabelId}
            disabled={negated || conditionCap.blocked}
            onClick={() => onChange(insertAt(root, path, newCondition()))}
          >
            Add condition
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={addLabelId}
            disabled={negated || groupCap.blocked}
            onClick={() => onChange(insertAt(root, path, newGroup()))}
          >
            Add group
          </Button>
        </div>
        {/* Whichever control's own cap fires first gets said -- "Add
         * condition" is disabled strictly before, or together with, "Add
         * group" (capBlock's own doc comment: it costs fewer nodes and sits
         * one level shallower), so its message is shown first when both are
         * blocked, and the group-only message only when condition alone
         * still has room. */}
        {conditionCap.blocked && (
          <p className="text-xs text-muted-foreground">{conditionCap.message}</p>
        )}
        {!conditionCap.blocked && groupCap.blocked && (
          <p className="text-xs text-muted-foreground">{groupCap.message}</p>
        )}
      </div>
    </div>
  )
}
