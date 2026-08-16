/**
 * Renders a `FilterNode` as a single readable line -- the collapsed view of
 * a tree, and the row label the builder shows before a node is expanded.
 * Pure and read-only: nothing here reaches into the tree, it only reads.
 */
import type { FilterNode, Window } from '@lyraflow/core/segments/ast.js'

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(' and ')
  if (value === null) return 'null'
  return String(value)
}

function formatWindow(window: Window): string {
  switch (window.kind) {
    case 'last':
      return `last ${window.n} ${window.unit}`
    case 'absolute':
      return `${window.from} to ${window.to}`
    case 'ever':
      return 'ever'
    default:
      return window satisfies never
  }
}

/**
 * A child rendered *inside* a group's join gets parenthesised when it is
 * itself a group, so precedence survives being flattened onto one line --
 * `a or (b and c)` is not the same segment as `a or b and c`. The top-level
 * call in `summarise` never adds this outer pair: a group passed directly
 * renders as its bare join, matching how the builder shows the tree it is
 * currently inside rather than a clause nested one level down.
 */
function part(node: FilterNode): string {
  return node.kind === 'group' ? `(${summarise(node)})` : summarise(node)
}

export function summarise(node: FilterNode): string {
  switch (node.kind) {
    case 'group':
      return node.children.map(part).join(` ${node.op} `)
    case 'not':
      return `not (${summarise(node.child)})`
    case 'trait':
      return `${node.key} ${node.operator} ${formatValue(node.value)}`
    case 'context':
      return `${node.field} (${node.scope}) ${node.operator} ${formatValue(node.value)}`
    case 'lifecycle':
      return `${node.field} ${node.operator} ${formatValue(node.value)}`
    case 'behavior': {
      const clause = node.aggregate === 'count' ? 'count' : `${node.aggregate} of ${node.property}`
      const base = `${clause} of ${node.event} in ${formatWindow(node.window)} ${node.operator} ${formatValue(node.value)}`
      if (!node.where || node.where.length === 0) return base
      const where = node.where
        .map((w) => `${w.property} ${w.operator} ${formatValue(w.value)}`)
        .join(', ')
      return `${base} where ${where}`
    }
    default:
      return node satisfies never
  }
}
