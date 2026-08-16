/**
 * Every tree edit lives here, and every function is pure: none of them
 * writes into an existing node. A component calls one of these with a path
 * and hands the returned root upward -- it never reaches into a node and
 * assigns a field. That is what makes "a node edits its sibling" (the
 * characteristic defect of a recursive editor: a handler closing over a
 * stale index, a mutation that writes through a shared reference)
 * unreachable rather than merely avoided.
 *
 * Untouched subtrees are shared by reference, not deep-cloned: only the
 * nodes on the spine from the root down to the addressed path are rebuilt.
 * That is what keeps a 100-node tree (the server's own MAX_TREE_NODES,
 * packages/core/src/segments/validate.ts) cheap to re-render on every edit.
 *
 * ## Path semantics
 *
 * A `path` is `number[]`, the child indices from the root, but it addresses
 * positions in `group.children` arrays only -- a `not` wrapper is never a
 * level the path navigates through. `not` is a presentation state of the
 * node beneath it: `nodeAt(root, [0])` returns the `not` wrapper itself when
 * `root.children[0]` is negated, not the child inside it. Reaching a node
 * nested *under* a `not` uses the same indices the un-negated tree would --
 * a `not` never consumes a path segment -- so descent silently passes
 * through a `not` only when there is more path left to consume, and never
 * once the path is exhausted. That asymmetry is what keeps `negateAt`
 * unambiguous about what it is wrapping: the same path that finds a node
 * also finds it once it has been wrapped in `not`.
 */
import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'

function isPathIndex(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0
}

/**
 * Descends from `node` along `path`, starting at segment `i`. Stops the
 * instant `i` reaches `path.length` -- even if the node standing there is a
 * `not` -- which is the rule that makes `nodeAt(root, [0])` return a `not`
 * wrapper rather than silently reaching through it. Only descends *through*
 * a `not` (without consuming a path segment) when there is still path left
 * to resolve.
 */
function descend(node: FilterNode, path: number[], i: number): FilterNode | null {
  if (i === path.length) return node
  if (node.kind === 'not') return descend(node.child, path, i)
  if (node.kind !== 'group') return null // a leaf, but the path continues past it
  const idx = path[i]
  if (idx === undefined || !isPathIndex(idx) || idx >= node.children.length) return null
  return descend(node.children[idx] as FilterNode, path, i + 1)
}

/** Returns the node addressed by `path`, or `null` if the path does not
 * resolve against `root` (an out-of-range index, or a path that continues
 * past a leaf). See the module doc for what a `not` along the way does. */
export function nodeAt(root: FilterNode, path: number[]): FilterNode | null {
  return descend(root, path, 0)
}

/**
 * Rebuilds the spine from `root` down to the node addressed by `path`,
 * replacing that node with `replacer(node)`. Every node off the spine is
 * shared by reference with `root`. Used by `replaceAt`, `insertAt` (whose
 * `replacer` requires a `group` and appends to it) and `negateAt` (whose
 * `replacer` wraps or unwraps). Throws on a path that does not resolve,
 * since every caller here builds `path` from a `nodeAt` result or from tree
 * structure it already knows -- an unresolvable path is a caller bug, not
 * data to degrade gracefully around.
 */
function rebuildAt(
  node: FilterNode,
  path: number[],
  i: number,
  replacer: (target: FilterNode) => FilterNode,
): FilterNode {
  if (i === path.length) return replacer(node)
  if (node.kind === 'not') return { kind: 'not', child: rebuildAt(node.child, path, i, replacer) }
  if (node.kind !== 'group') {
    throw new Error('tree.ts: path continues past a leaf node')
  }
  const idx = path[i]
  if (idx === undefined || !isPathIndex(idx) || idx >= node.children.length) {
    throw new Error(`tree.ts: path index ${String(idx)} is out of range`)
  }
  const children = node.children.map((child, ci) =>
    ci === idx ? rebuildAt(child, path, i + 1, replacer) : child,
  )
  return { ...node, children }
}

/** Appends `node` to the end of the children of the group addressed by
 * `path`. `path` addresses the group itself -- `insertAt(root, [], n)`
 * appends to `root`'s own children. Throws if `path` does not resolve to a
 * `group` (in particular, a `not` wrapper is never a valid insert target;
 * unwrap it with `negateAt` first). */
export function insertAt(root: FilterNode, path: number[], node: FilterNode): FilterNode {
  return rebuildAt(root, path, 0, (target) => {
    if (target.kind !== 'group') {
      throw new Error('insertAt: path must address a group')
    }
    return { ...target, children: [...target.children, node] } satisfies Group
  })
}

/** Replaces the node addressed by `path` with `node` entirely -- including
 * a change of `kind`, e.g. swapping a trait for a behaviour in place. */
export function replaceAt(root: FilterNode, path: number[], node: FilterNode): FilterNode {
  return rebuildAt(root, path, 0, () => node)
}

/**
 * Sentinel meaning "this whole subtree is gone" -- returned internally by
 * `removeFrom` when removing a child would leave a `group` with zero
 * children. A `group` requires at least one child
 * (packages/core/src/segments/ast.ts's `children: z.array(FilterNode).min(1)`);
 * an empty one is not a legal tree, so it collapses out of its OWN parent
 * too, recursively -- removing the last trait from a group two levels deep
 * can empty the group above it as well, and that keeps propagating upward
 * until a level is left with a sibling, or the root is reached. A `not` can
 * never be left with zero children at all (it wraps exactly one `child`
 * field, not an array), so if the node it wraps collapses, the `not`
 * collapses too, unconditionally -- there is no "empty not" to fall back
 * to the way there is an "empty group".
 */
const REMOVE = Symbol('tree.ts: subtree removed')

/**
 * Removes the child addressed by `path` from its containing group, and
 * collapses any group left with zero children out of its own parent in
 * turn -- see `REMOVE` above. The root is the one exception: it has no
 * parent to collapse into, so removing the last child of the root group
 * returns that group with an empty `children` array -- a legal-shaped but
 * meaningless segment -- rather than collapsing or throwing. This module
 * does not invent an empty-tree representation beyond that; the caller
 * (the builder) must treat an empty root as its own save-disabled state.
 *
 * Unlike the other edits, `path` here addresses the child to remove, not a
 * group to operate on, so removal happens one level below the terminal
 * step of ordinary descent: the last path segment is resolved against
 * whichever group owns it -- which may be reached by first passing
 * transparently through a `not`, per the module's path semantics -- and
 * that segment is then used to filter, not to descend further. Removing
 * the root itself (`path === []`) has no parent to remove it from and is
 * rejected.
 */
export function removeAt(root: FilterNode, path: number[]): FilterNode {
  if (path.length === 0) {
    throw new Error('removeAt: cannot remove the root')
  }
  const result = removeFrom(root, path, 0, true)
  if (result === REMOVE) {
    // Only reachable if `root` itself is a bare `not` whose single child
    // collapsed -- there is no legal empty-`not` fallback the way there is
    // for an empty root group.
    throw new Error('removeAt: removing this node would leave the root with nothing to wrap')
  }
  return result
}

function removeFrom(
  node: FilterNode,
  path: number[],
  i: number,
  isRoot: boolean,
): FilterNode | typeof REMOVE {
  if (node.kind === 'not') {
    const child = removeFrom(node.child, path, i, false)
    return child === REMOVE ? REMOVE : { kind: 'not', child }
  }
  if (node.kind !== 'group') {
    throw new Error('removeAt: path continues past a leaf node')
  }
  const idx = path[i]
  if (idx === undefined || !isPathIndex(idx) || idx >= node.children.length) {
    throw new Error(`removeAt: path index ${String(idx)} is out of range`)
  }
  const newChildren: FilterNode[] =
    i === path.length - 1
      ? node.children.filter((_, ci) => ci !== idx)
      : node.children.flatMap((child, ci) => {
          if (ci !== idx) return [child]
          const result = removeFrom(child, path, i + 1, false)
          return result === REMOVE ? [] : [result]
        })
  if (newChildren.length === 0 && !isRoot) return REMOVE
  return { ...node, children: newChildren }
}

/** Toggles negation of the node addressed by `path`: wraps an unwrapped
 * node in `{ kind: 'not', child: node }`, or unwraps a `not` back to the
 * node it wraps. The same `path` addresses the node both before and after
 * the toggle -- see the module doc. */
export function negateAt(root: FilterNode, path: number[]): FilterNode {
  return rebuildAt(root, path, 0, (target) =>
    target.kind === 'not' ? target.child : { kind: 'not', child: target },
  )
}

/**
 * Depth-first walk yielding every node with its depth, root at depth 0.
 * Deliberately shaped to match `walk` in
 * packages/core/src/segments/validate.ts exactly -- same yield-self-first
 * order, same `depth + 1` on descent into a `group` child or a `not`'s
 * child -- because `countNodes`, `maxDepth` and `countBehaviours` below
 * exist to disable UI controls *before* the server would reject a tree
 * (Task 6). If this walk disagreed with validateTree's, the UI would either
 * block a legal tree or let an illegal one through the same click that
 * `validateTree` would then reject.
 */
function* walk(node: FilterNode, depth: number): Generator<{ node: FilterNode; depth: number }> {
  yield { node, depth }
  if (node.kind === 'group') {
    for (const child of node.children) yield* walk(child, depth + 1)
  } else if (node.kind === 'not') {
    yield* walk(node.child, depth + 1)
  }
}

/** Total node count, matching validateTree's `nodes` counter: every visited
 * node counts, including a `not` wrapper itself. */
export function countNodes(root: FilterNode): number {
  let n = 0
  for (const _ of walk(root, 0)) n++
  return n
}

/** The deepest `depth` reached by the walk above, root at 0 -- matching
 * validateTree's `depth` exactly, so `maxDepth(root) >= MAX_TREE_DEPTH - 1`
 * is the same "one more level would be rejected" boundary validateTree
 * enforces via `depth >= MAX_TREE_DEPTH`. */
export function maxDepth(root: FilterNode): number {
  let max = 0
  for (const { depth } of walk(root, 0)) if (depth > max) max = depth
  return max
}

/** Count of `behavior` nodes, matching validateTree's `behaviors` counter. */
export function countBehaviours(root: FilterNode): number {
  let n = 0
  for (const { node } of walk(root, 0)) if (node.kind === 'behavior') n++
  return n
}
