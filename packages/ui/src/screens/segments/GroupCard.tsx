import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import { Button } from '../../components/ui/button.js'
import { Label } from '../../components/ui/label.js'
import { ConditionRow } from './ConditionRow.js'
import { insertAt, negateAt, nodeAt, removeAt, replaceAt } from './tree.js'

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
 */
export function GroupCard(props: {
  root: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
}) {
  const { root, path, onChange } = props
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
            return <GroupCard key={key} root={root} path={childPath} onChange={onChange} />
          }
          return (
            <ConditionRow
              key={key}
              node={child}
              path={childPath}
              onChange={(next) => onChange(replaceAt(root, childPath, next))}
              onRemove={() => onChange(removeAt(root, childPath))}
              onNegate={() => onChange(negateAt(root, childPath))}
            />
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={negated}
          onClick={() => onChange(insertAt(root, path, newCondition()))}
        >
          Add condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={negated}
          onClick={() => onChange(insertAt(root, path, newGroup()))}
        >
          Add group
        </Button>
      </div>
    </div>
  )
}
