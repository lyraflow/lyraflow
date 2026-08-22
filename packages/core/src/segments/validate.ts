import type { FilterNode, SegmentQuery } from './ast.js'

/**
 * These bound work, not taste. A segment query is reachable by an
 * authenticated caller, and every one of these limits is the difference
 * between a slow query and one that does not terminate.
 */
export const MAX_TREE_DEPTH = 10
export const MAX_TREE_NODES = 100
/**
 * Lower than MAX_TREE_NODES because behavioural nodes are not like the
 * others: each one adds a conditional aggregate to the single pass over
 * `events`, which is the most expensive relation in the system. A hundred
 * trait predicates is a wide but cheap join; a hundred conditional
 * aggregates over all history is not.
 */
export const MAX_BEHAVIOR_NODES = 25

export class SegmentValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'depth' | 'nodes' | 'behaviors',
  ) {
    super(message)
    this.name = 'SegmentValidationError'
  }
}

interface Visited {
  node: FilterNode
  path: string
  depth: number
}

/** Depth-first walk yielding every node with a dotted path for error messages. */
function* walk(node: FilterNode, path: string, depth: number): Generator<Visited> {
  yield { node, path, depth }
  if (node.kind === 'group') {
    for (const [i, child] of node.children.entries()) {
      yield* walk(child, `${path}.children[${i}]`, depth + 1)
    }
  } else if (node.kind === 'not') {
    yield* walk(node.child, `${path}.child`, depth + 1)
  }
}

export function validateTree(q: SegmentQuery): void {
  let nodes = 0
  let behaviors = 0
  for (const { node, depth } of walk(q.filter, 'filter', 0)) {
    // Checked inside the loop rather than after it so that a pathological
    // tree is rejected while being counted, not after being fully walked.
    if (depth >= MAX_TREE_DEPTH) {
      throw new SegmentValidationError(
        `filter tree is nested deeper than ${MAX_TREE_DEPTH} levels`,
        'depth',
      )
    }
    if (++nodes > MAX_TREE_NODES) {
      throw new SegmentValidationError(`filter tree has more than ${MAX_TREE_NODES} nodes`, 'nodes')
    }
    if (node.kind === 'behavior' && ++behaviors > MAX_BEHAVIOR_NODES) {
      throw new SegmentValidationError(
        `filter tree has more than ${MAX_BEHAVIOR_NODES} behavioural conditions`,
        'behaviors',
      )
    }
  }
}

/**
 * Behaviour nodes anywhere in one tree.
 *
 * Exported so the funnel validator's own cap counts EXACTLY the nodes
 * `MAX_BEHAVIOR_NODES` counts. A second hand-written walk over there is how
 * one of the two ends up disagreeing about whether a `not`-wrapped behaviour
 * counts, and the disagreement would surface as a funnel that validates and
 * then outruns its own budget.
 */
export function countBehaviourNodes(filter: FilterNode): number {
  let n = 0
  for (const { node } of walk(filter, 'filter', 0)) if (node.kind === 'behavior') n++
  return n
}

export interface CostWarning {
  /** Dotted path to the node, so the builder can highlight it. */
  path: string
  reason: string
}

/**
 * Non-fatal. These trees run; they are just expensive enough that the person
 * building the segment should know before pressing the button. Naming the
 * node is the point — "this segment is slow" is not actionable, "the
 * `import_started` condition scans all history" is.
 */
export function costWarnings(q: SegmentQuery): CostWarning[] {
  const out: CostWarning[] = []
  for (const { node, path } of walk(q.filter, 'filter', 0)) {
    if (node.kind !== 'behavior') continue
    if (node.window.kind === 'ever') {
      out.push({
        path,
        reason: `the \`${node.event}\` condition uses an \`ever\` window, which scans all history rather than a bounded window`,
      })
    }
    if (node.event === '*') {
      out.push({
        path,
        reason: 'this condition matches every event, so it cannot use the event-name index',
      })
    }
  }
  return out
}
