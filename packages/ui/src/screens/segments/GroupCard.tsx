import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { Label } from '../../components/ui/label.js'
import { ConditionRow } from './ConditionRow.js'
import {
  countBehaviours,
  countNodes,
  insertAt,
  negateAt,
  nodeAt,
  removeAt,
  replaceAt,
} from './tree.js'

/** A new, empty leaf inserted by "Add condition". Tasks 5 and 6 give an
 * operator real fields to fill in; until then it renders through
 * `ConditionRow`'s placeholder body exactly like any other trait node. */
function newCondition(): FilterNode {
  return { kind: 'trait', key: '', operator: '=', value: '' }
}

/**
 * A new nested group inserted by "Add group" -- seeded with ONE default
 * condition (the same one `newCondition` inserts), never empty.
 *
 * Controller ruling (Task 4 fix round 1): a group with zero children is not
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
 * `SegmentBuilder`'s empty-root save-disable (controller correction 2)
 * remains the backstop for the one empty-group state that IS still
 * reachable: removing the root's last remaining condition, which
 * `removeAt` deliberately leaves as an empty root rather than collapsing.
 */
function newGroup(): FilterNode {
  return { kind: 'group', op: 'and', children: [newCondition()] }
}

/** Whether a control is blocked by one of the three server-side caps
 * (`packages/core/src/segments/validate.js`), and which one -- so the
 * button can say what it's waiting on rather than merely refuse.
 *
 * `extraNodes`/`extraDepth` are how many nodes, and how many levels deeper
 * than THIS group's own `depth`, the control being checked would add:
 * "Add condition" inserts one leaf one level below this group (1, 1); "Add
 * group" inserts a group AND the one condition it is seeded with -- never
 * empty, `newGroup`'s own doc comment -- so it costs two nodes, and its
 * seeded child sits two levels below this group, not one (2, 2). Checking
 * the deeper of a control's own two new nodes against `MAX_TREE_DEPTH` is
 * sufficient: the shallower one can never be the one that first exceeds the
 * cap, since it is strictly less deep.
 *
 * Node and behaviour counts are GLOBAL -- adding anywhere in the tree
 * consumes the same shared budget, so every `GroupCard` at every depth
 * checks the same `nodeCount`/`behaviorCount` computed from the whole
 * `root`, not its own subtree. Depth is LOCAL -- a group nine levels down
 * one branch does not cap a group two levels down another -- so it is
 * checked against `depth` (this group's own `path.length`), not
 * `maxDepth(root)`.
 *
 * The behaviour cap is included even though NEITHER control this task ships
 * can itself create a `behavior` node -- there is no kind-switcher in this
 * plan, so a behaviour condition only ever arrives already in a fetched
 * tree. Checked anyway, defensively, against the day a kind-switcher lands
 * and "Add condition" can produce one; see the Task 6 report for the
 * reasoning this is a forward guard, not a defect fix, today.
 */
function capBlock(
  nodeCount: number,
  behaviorCount: number,
  depth: number,
  extraNodes: number,
  extraDepth: number,
): { blocked: boolean; message: string } {
  if (nodeCount + extraNodes > MAX_TREE_NODES) {
    return {
      blocked: true,
      message: `This segment already has ${MAX_TREE_NODES} conditions, the maximum allowed in one segment.`,
    }
  }
  if (depth + extraDepth >= MAX_TREE_DEPTH) {
    return {
      blocked: true,
      message: `This branch is nested as deep as segments allow (${MAX_TREE_DEPTH} levels).`,
    }
  }
  if (behaviorCount >= MAX_BEHAVIOR_NODES) {
    return {
      blocked: true,
      message: `This segment already has ${MAX_BEHAVIOR_NODES} behavioural conditions, the maximum allowed.`,
    }
  }
  return { blocked: false, message: '' }
}

/**
 * Renders the group addressed by `path` inside `root` as a card: a
 * "Match" operator select, its children (each a nested `GroupCard` or a
 * `ConditionRow`), and controls to add a condition or a nested group.
 *
 * Every child is keyed by ITS OWN PATH, joined to a string -- never by
 * array index. An index key lets React reuse a removed or shifted child's
 * component instance (and whatever local state Tasks 5/6 give it) for
 * whatever node now sits at that index after an insert or remove, which is
 * exactly wrong: the instance should follow the NODE, and a node's identity
 * here is its path. Every handler below is created fresh inside this
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
 * component itself, purely to reach `BehaviourForm` (Task 6) at whatever
 * depth a `behavior` leaf sits -- the same reason `StepRows` threads them to
 * `EventCombobox` in the funnels builder.
 *
 * Task 6 also adds the three server-side caps (`MAX_TREE_NODES`,
 * `MAX_TREE_DEPTH`, `MAX_BEHAVIOR_NODES`, all from
 * `packages/core/src/segments/validate.js`) as a DISABLE here, computed
 * fresh on every render from `root` -- see `capBlock`'s own doc comment for
 * why node/behaviour counts are global but depth is local to this group.
 */
export function GroupCard(props: {
  root: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
}) {
  const { root, path, onChange, client, projectId, onUnauthorized } = props
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

  // Global counts (the whole tree shares one budget for these), local depth
  // (this group's own position) -- see `capBlock`'s own doc comment.
  const nodeCount = countNodes(root)
  const behaviorCount = countBehaviours(root)
  const depth = path.length
  const conditionCap = capBlock(nodeCount, behaviorCount, depth, 1, 1)
  const groupCap = capBlock(nodeCount, behaviorCount, depth, 2, 2)

  function setOp(op: 'and' | 'or') {
    const nextGroup: Group = { ...group, op }
    onChange(replaceAt(root, path, negated ? { kind: 'not', child: nextGroup } : nextGroup))
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3"
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
          <option value="and">all conditions (AND)</option>
          <option value="or">any condition (OR)</option>
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

      <div className="flex flex-col gap-2 border-l border-border pl-3">
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
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={negated || conditionCap.blocked}
            onClick={() => onChange(insertAt(root, path, newCondition()))}
          >
            Add condition
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
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
