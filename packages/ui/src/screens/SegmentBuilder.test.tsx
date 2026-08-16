import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment, SegmentPreview } from '../api/types.js'
import { ProjectProvider, useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentEditPath, segmentPath } from '../app/Router.js'
import { DEBOUNCE_MS, SegmentBuilder } from './SegmentBuilder.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

const TREE: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'pro' }],
}

const SEGMENT: Segment = {
  id: 7,
  name: 'Paying customers',
  ast_version: 1,
  filter: TREE,
  stale: false,
  last_count: 12,
  last_evaluated_at: '2026-08-15T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const PREVIEW: SegmentPreview = {
  person_count: 42,
  warnings: [],
  as_of: '2026-08-16T00:00:00.000Z',
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    segment: vi.fn(async () => SEGMENT),
    createSegment: vi.fn(async () => ({ ...SEGMENT, id: 42 })),
    // Rename ONLY (never carries a tree) vs tree update ONLY
    // (never carries a name) -- two methods, deliberately, so a caller
    // cannot send the wrong one by accident (this file's own "the sharpest
    // rule in this plan" tests, below).
    renameSegment: vi.fn(async () => SEGMENT),
    updateSegmentTree: vi.fn(async () => SEGMENT),
    // The cap fixtures render REAL `behavior` leaves -- each one
    // mounts a `BehaviourForm` -> `EventCombobox`, whose debounced effect
    // calls `schemaEvents` even with a non-empty seeded value. Without
    // this, that fires as an uncaught async exception once
    // any fixture in this file reaches a behavior leaf, since no earlier
    // test ever did.
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
    // EVERY dirtying edit in this file now starts a real
    // `debounceMs` timer that, once it fires, calls this -- on real timers
    // (every test above this point) that is a genuine 600ms wall-clock
    // wait, not a no-op, so a fixture that dirties the tree but finishes
    // its own assertions slower than that (this machine's own documented
    // contention) would otherwise hit an unmocked `previewSegment` and
    // throw inside a timer callback. Same defensive shape as
    // `schemaEvents`/`schemaProperties` above.
    previewSegment: vi.fn(async () => PREVIEW),
    ...over,
  } as unknown as ApiClient & {
    segment: Mock
    createSegment: Mock
    renameSegment: Mock
    updateSegmentTree: Mock
  }
}

function renderBuilder(client: ApiClient = fakeClient(), editId?: number) {
  render(
    <MemoryRouter initialEntries={[editId != null ? segmentEditPath(editId) : ROUTES.segmentNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path={ROUTES.segmentNew} element={<SegmentBuilder client={client} />} />
          <Route path="/segments/:id/edit" element={<SegmentBuilder client={client} />} />
          {/* Placeholders so a successful save's navigation has somewhere
           * to land, matching FunnelBuilder.test.tsx's own harness. */}
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
          <Route path="/segments/:id" element={<p>segment detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

/** Renders in EDIT mode against a segment shaped by `overrides`
 * (`{ ...SEGMENT, ...overrides }`) -- mutates the given `fakeClient`'s own
 * `segment` mock in place rather than building a fresh client, so a test
 * can still assert on the SAME client object's `renameSegment`/
 * `updateSegmentTree` mocks it already holds a reference to. */
function renderEdit(
  client: ApiClient & { segment: Mock },
  overrides: Partial<Segment> & { id: number },
) {
  client.segment.mockResolvedValue({ ...SEGMENT, ...overrides })
  renderBuilder(client, overrides.id)
}

describe('SegmentBuilder -- create', () => {
  it('starts at an empty root, save disabled, and shows the empty state', async () => {
    renderBuilder()
    expect(await screen.findByTestId('group-')).toBeInTheDocument()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('enables save once a name is set and a condition exists, disabled again if either is missing', async () => {
    renderBuilder()
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('save creates the segment with the typed name and current tree, then navigates to the list', async () => {
    const client = fakeClient()
    renderBuilder(client)
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.createSegment).toHaveBeenCalledTimes(1))
    const call = client.createSegment.mock.calls[0]
    if (!call) throw new Error('createSegment was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe('VIPs')
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: '', operator: '=', value: '' }],
      },
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })

  it('routes a 401 on save to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      createSegment: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.segmentNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <SegmentBuilder client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SegmentBuilder -- edit', () => {
  it('seeds the name and tree from the fetched segment', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    expect(await screen.findByLabelText(/name/i)).toHaveValue('Paying customers')
    // The placeholder leaf (plain `summarise` text) was replaced with a
    // real `TraitForm` -- an `<input>`'s `value` is never DOM text content,
    // so the fetched trait's data is pinned through its own fields instead.
    const condition = within(screen.getByTestId('condition-0'))
    expect(condition.getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(condition.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(condition.getByRole('textbox', { name: /^value$/i })).toHaveValue('pro')
  })

  // An UNCHANGED save sends nothing to the server at all (see
  // SegmentBuilder's own doc comment), so this fixture makes a real tree
  // edit (appending to the existing trait's value) before saving, to keep
  // pinning "edit mode goes through updateSegmentTree, not createSegment"
  // as a distinct fact from the three tests below.
  it('save sends the current tree through updateSegmentTree, never createSegment', async () => {
    const client = fakeClient()
    renderBuilder(client, SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.type(
      within(screen.getByTestId('condition-0')).getByRole('textbox', { name: /^value$/i }),
      'X',
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(client.createSegment).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
    const call = client.updateSegmentTree.mock.calls[0]
    if (!call) throw new Error('updateSegmentTree was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe(SEGMENT.id)
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'proX' }],
      },
    })
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
  })

  it('a save with no name or tree change reaches neither renameSegment nor updateSegmentTree, and still navigates to detail', async () => {
    // The other half of the coincidence: a
    // fixture where NOTHING changed must not be indistinguishable from one
    // where the tree happens to round-trip back to its original shape --
    // this pins that clicking Save on an untouched segment issues no
    // request at all, matching "never send the tree along a rename" taken
    // to its limit.
    const client = fakeClient()
    renderBuilder(client, SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('removing the only condition disables save and shows the empty state again', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /remove/i }),
    )
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
  })

  it('a stale segment cannot be edited here, and save is disabled', async () => {
    renderBuilder(
      fakeClient({ segment: vi.fn(async () => ({ ...SEGMENT, stale: true })) }),
      SEGMENT.id,
    )
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
    expect(screen.queryByTestId('group-')).toBeNull()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})

// --- The sharpest rule in this plan. `PATCH /v1/segments/:id`
// decides whether to touch the filter tree by whether the body carries one
// AT ALL, not by comparing old against new -- so a rename that ships the
// whole definition resets the segment's cached count snapshot and returns
// `200`, silently. `renameSegment` (name only) and `updateSegmentTree`
// (tree only) are separate `ApiClient` methods for exactly this reason.
// Every assertion below is on the REQUEST, never merely on a control's
// enabled/disabled state -- a screen that disables the wrong button but
// still fires the wrong call would pass a control-only test.

describe('SegmentBuilder -- the rename rule', () => {
  /** A single click on condition-0's own Negate button -- a real,
   * content-changing edit (wraps the leaf in a `not`, `ConditionRow`'s own
   * doc comment), unlike the cap fixtures' negate-TWICE helper, which
   * dirties the tree without changing its final shape. One click is what
   * this file needs: a tree edit that `originalRoot` comparison actually
   * sees as changed. */
  async function negateTheFirstCondition() {
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
  }

  it('a rename sends the name alone, never the tree', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The assertion that matters is about the REQUEST, not the control.
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })

  it('a tree edit sends the tree', async () => {
    // So the guard above cannot be satisfied by never sending one.
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalled())
  })

  it('a name and tree change together sends both, and neither call is malformed', async () => {
    // Two PATCHes is fine; one carrying both is not, because the rename
    // path is the only one that preserves the snapshot and it must stay
    // tree-free.
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalled())
    expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New')
    // The tree call carries no name, and the rename carries no tree.
    const treeCall = client.updateSegmentTree.mock.calls[0]
    const renameCall = client.renameSegment.mock.calls[0]
    if (!treeCall || !renameCall) throw new Error('both calls were expected')
    expect(treeCall[2]).not.toHaveProperty('name')
    expect(renameCall[2]).toBe('New')
  })

  // Mutation 1: a save with ONLY a name change must not
  // merely skip `updateSegmentTree` -- it must not navigate before the
  // rename's own promise settles, and it must navigate to DETAIL (edit's
  // own destination), never the list (create's).
  it('a rename-only save navigates to the segment detail route, not the list', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(screen.queryByText('segments list')).toBeNull()
  })

  // Mutation 2: a tree that is edited and then edited BACK
  // to its exact original shape (negate, negate again) must read as
  // UNCHANGED -- content equality against `originalRoot`, not the `dirty`
  // flag, which is set once and never cleared. A rename alongside a
  // round-tripped tree edit must still take the rename-only path.
  it('a tree edited back to its original shape is not treated as a tree change, even alongside a rename', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await negateTheFirstCondition() // back to the original shape
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })

  // An edit save can issue TWO PATCHes (rename + tree update),
  // and `Promise.all` rejects the instant either one does -- possibly AFTER
  // the other has already committed. The error copy used to say "nothing
  // was changed on the server", which is false in exactly this shape. This
  // fixture forces that shape (the rename succeeds, the tree update fails)
  // and pins that the banner never claims it.
  it('a failed edit save (rename succeeds, tree update fails) says to retry, and never claims nothing was changed on the server', async () => {
    const client = fakeClient({
      updateSegmentTree: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not save this segment/i)
    expect(alert).not.toHaveTextContent(/nothing was changed/i)
    expect(alert).not.toHaveTextContent(/nothing changed/i)
  })

  // --- After a PARTIAL save, the fetch-time snapshot describes a server
  // state that no longer exists. The retry advice above is only honest if
  // each request advances its own baseline the moment it commits: the
  // operator's natural response to a save error is to change something and
  // save again, and against a stale baseline that second save silently
  // drops whichever field they reverted. Two tests, one per side, because
  // either baseline can be the one that committed.

  it('after a partial save, reverting the name still sends the rename -- the committed side is the new baseline', async () => {
    const client = fakeClient({
      updateSegmentTree: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(500, 'server_error'))
        .mockResolvedValue(SEGMENT),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The rename committed; the tree update did not. The server now holds
    // `New`, which is not what `originalName` was fetched as.
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this segment/i)

    // The operator abandons the rename and saves again.
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Old')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(2))
    // The assertion that matters is the REQUEST: without this the screen
    // navigates away reporting success while the segment is still called
    // `New` on the server.
    expect(client.renameSegment).toHaveBeenCalledTimes(2)
    expect(client.renameSegment).toHaveBeenLastCalledWith(1, 7, 'Old')
  })

  it('after a partial save, reverting the tree still sends the tree -- the committed side is the new baseline', async () => {
    // The mirror: this time the TREE update is the side that lands.
    const client = fakeClient({
      renameSegment: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(500, 'server_error'))
        .mockResolvedValue(SEGMENT),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this segment/i)

    // The operator un-negates, restoring the tree the segment was FETCHED
    // with -- which the successful first request means is no longer the
    // tree the server holds.
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(2))
    const second = client.updateSegmentTree.mock.calls[1]
    if (!second) throw new Error('a second tree update was expected')
    expect(second[2]).toEqual({ ast_version: 1, filter: TREE })
  })

  // --- A stored name is compared TRIMMED on both sides. Otherwise a
  // segment named with surrounding whitespace issues a rename nobody asked
  // for on every save, and "a save with neither changed issues no request
  // at all" stops being true of exactly those segments.

  it('a stored name with surrounding whitespace is not a rename: a tree-only edit sends only the tree', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: '  Paying customers  ', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(client.renameSegment).not.toHaveBeenCalled()
  })

  it('a save with nothing changed issues no request at all, for a whitespace-padded name too', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: '  Paying customers  ', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })
})

// --- The three server-side tree caps, enforced end to end through
// SegmentBuilder -- GroupCard computes them from the SAME `root` this
// screen owns (see SegmentBuilder's own doc comment on why the wiring
// lives here), so these pin the whole chain rather than GroupCard in
// isolation (already covered directly by GroupCard.test.tsx). Each fixture
// is deliberately seeded via EDIT mode (a fetched segment already at, or
// one below, its cap) rather than reached by clicking through 100 times.

describe('SegmentBuilder -- the three server-side tree caps', () => {
  const trait = (key: string): FilterNode => ({ kind: 'trait', key, operator: '=', value: 'x' })
  const behaviorLeaf = (event: string): FilterNode => ({
    kind: 'behavior',
    event,
    aggregate: 'count',
    window: { kind: 'last', n: 1, unit: 'days' },
    operator: '>=',
    value: 1,
  })

  /** A flat root with `n` leaves -- countNodes = n + 1 (the root group
   * counts too). Flat and single-level so exactly one "Add condition"
   * button exists on the whole page -- no `within(...)` scoping needed. */
  function flatRoot(n: number, leaf: (key: string) => FilterNode): FilterNode {
    return {
      kind: 'group',
      op: 'and',
      children: Array.from({ length: n }, (_, i) => leaf(`k${i}`)),
    }
  }

  it('disables add-condition at the node cap, says which cap, and never requests a preview or a save', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: flatRoot(MAX_TREE_NODES - 1, trait), // countNodes === MAX_TREE_NODES
      })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeDisabled()
    expect(screen.getByText(new RegExp(String(MAX_TREE_NODES)))).toBeInTheDocument()
    // Letting the server reject a tree the operator spent five minutes
    // building is the failure being prevented -- so nothing this screen
    // can send (today, or once previewSegment is wired in) fires.
    expect(client.previewSegment).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  }, 15000)

  it('disables add-condition at the depth cap, and says which cap', async () => {
    // A chain of MAX_TREE_DEPTH - 1 nested single-child groups, bottoming
    // out in a group at depth MAX_TREE_DEPTH - 1 whose own child is a leaf
    // at depth MAX_TREE_DEPTH -- ONE PAST the deepest node validateTree
    // accepts (it rejects on `depth >= MAX_TREE_DEPTH`, so MAX_TREE_DEPTH -
    // 1 is the deepest LEGAL depth, matching GroupCard.test.tsx's own
    // fixture at the same boundary). Every level along the chain renders
    // its OWN Add-condition
    // (all but the deepest stay enabled), so this scopes to the deepest
    // group's own testid rather than an unscoped query, which would be
    // ambiguous the moment the tree has more than one group in it.
    let filter: FilterNode = { kind: 'group', op: 'and', children: [trait('leaf')] }
    for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) {
      filter = { kind: 'group', op: 'and', children: [filter] }
    }
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const deepPath = Array.from({ length: MAX_TREE_DEPTH - 1 }, () => 0)
    const deepGroup = await screen.findByTestId(`group-${deepPath.join('-')}`)
    const add = within(deepGroup).getByRole('button', { name: /^add condition$/i })
    expect(add).toBeDisabled()
    expect(within(deepGroup).getByText(new RegExp(String(MAX_TREE_DEPTH)))).toBeInTheDocument()
    expect(client.previewSegment).not.toHaveBeenCalled()
  })

  // A tree already at the
  // behaviour cap must NOT block Add-condition -- `newCondition()` always
  // inserts a `trait`, never a `behavior`, and there is no kind-switcher
  // anywhere in this plan to change that. The server would accept the
  // trait; refusing it in the UI is the caps' own failure mode inverted --
  // rejecting a tree the server would take, with no route around it short
  // of the CLI.
  it('does not disable add-condition at the behaviour cap, since it can only ever add a trait', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: flatRoot(MAX_BEHAVIOR_NODES, behaviorLeaf),
      })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeEnabled()
  })

  it('one condition below the node cap, save is still reachable: Add condition is enabled', async () => {
    // The inverse check -- a cap test that only ever asserts the disabled
    // side could pass against code that disables Add-condition
    // unconditionally.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: flatRoot(MAX_TREE_NODES - 2, trait) })),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeEnabled()
  }, 15000)
})

// --- Live counts -- cheap automatically, costly on request. Fake
// timers are scoped to `withFakeTimers`, per test, never file- or
// describe-wide -- every test above this point relies on real timers, and
// `shouldAdvanceTime: true` (Feed.test.tsx's own `withFakeTimers`, mirrored
// here) keeps `userEvent`'s own internal delays working while this file's
// own `vi.advanceTimersByTimeAsync` calls stay exact.

describe('SegmentBuilder -- live counts', () => {
  async function withFakeTimers(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await run()
    } finally {
      vi.useRealTimers()
    }
  }

  /** A deferred promise a test can settle on its own schedule -- the only
   * way to provoke "landing order does not track issue order" rather than
   * merely assert it (mirrors `FunnelDetail.test.tsx`'s own `deferred`). */
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  /** Adds one condition and types into its key field -- a real edit through
   * `TreeEditor`'s own `onChange`, which is what marks the tree dirty
   * (`SegmentBuilder`'s own doc comment on why merely opening a segment
   * must not). */
  async function typeATrait() {
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    await userEvent.type(
      within(screen.getByTestId('condition-0')).getByRole('textbox', { name: /key/i }),
      'plan',
    )
  }

  const EVER_BEHAVIOUR: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'behavior',
        event: 'import_started',
        aggregate: 'count',
        window: { kind: 'ever' },
        operator: '>=',
        value: 1,
      },
    ],
  }

  // `EVER_BEHAVIOUR` above has exactly
  // ONE condition -- "the warning appears inside condition-0" was true
  // whether path association worked or not, and a mutation rendering EVERY
  // warning on EVERY row (`const ownWarnings = warnings`, dropping
  // `warningsAt`'s own path filter) passed every test built on it. This
  // fixture has TWO conditions, only one costly, specifically to make that
  // mutation observable: a warning showing up on the WRONG row is now a
  // distinct, assertable failure, not merely absent evidence.
  const MIXED_TREE: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      {
        kind: 'behavior',
        event: 'import_started',
        aggregate: 'count',
        window: { kind: 'ever' },
        operator: '>=',
        value: 1,
      },
    ],
  }

  /** Renders in EDIT mode against a segment already carrying a `behavior`
   * leaf with an `ever` window -- there is no kind-switcher anywhere in
   * this plan (`GroupCard`'s own doc comment: `newCondition()` always
   * inserts a `trait`), so a behaviour leaf can only ever be reached by
   * fetching one already shaped that way, never by clicking through the
   * create-mode UI. Also performs one real edit (Negate, twice, which
   * restores the original tree) so `dirty` is true going in -- proving the
   * COST WARNING itself blocks the preview, not merely the `dirty` gate
   * never having fired at all. */
  async function addBehaviourWithEverWindow(client: ApiClient) {
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    const negate = within(screen.getByTestId('condition-0')).getByRole('button', {
      name: /negate/i,
    })
    await userEvent.click(negate)
    await userEvent.click(negate)
  }

  it('previews a cheap tree automatically after editing stops', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client)
      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
    })
  })

  it('does not preview a tree carrying a cost warning, and says why', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient({
        segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
      })
      await addBehaviourWithEverWindow(client)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()
      expect(screen.getByText(/scans all history/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    })
  })

  it('renders each warning against the condition it names, via its path -- and not against the one it does not', async () => {
    // costWarnings returns { path, reason }. A warning rendered only as
    // prose in a page-level panel makes the operator hunt for which of 40
    // conditions is meant -- this pins that it renders INSIDE the
    // offending condition's own testid instead, using a tree with a CHEAP
    // trait beside the costly behaviour so a warning leaking onto the wrong
    // row is a distinct, catchable failure (see MIXED_TREE's own comment).
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: MIXED_TREE })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-1')
    expect(
      within(screen.getByTestId('condition-1')).getByText(/scans all history/i),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('condition-0')).queryByText(/scans all history/i)).toBeNull()
  })

  // The `dirty` gate, pinned directly: every cap fixture above already
  // shows a fetched, cheap, non-empty tree never calling `previewSegment`,
  // but each of those ALSO happens to sit at a cap that blocks editing --
  // this fixture sits one full trait below any cap, purely to isolate
  // "opening a segment reaches no server preview" from "a capped tree
  // cannot be edited into firing one" as two different reasons for the
  // same assertion.
  it('does not auto-preview merely from opening an existing (cheap) segment for editing', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()
    })
  })

  // Step 5's invariant, both halves: a response may be applied only if it
  // belongs to the MOST RECENT request this screen issued. Two counters,
  // not one -- a single counter that only gated `previewing` would leave
  // Run stuck disabled forever the moment an abandoned request's `.finally`
  // fired after a newer one already cleared it; a single counter that only
  // gated the result would apply a same-tree-shape coincidence. This test
  // resolves the NEWER request first (pinning the apply-guard) and then the
  // OLDER one late (pinning that a late, discarded landing changes nothing
  // -- not the count, not the Run button).
  it('discards a stale preview response that lands after the tree has changed again', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const p2 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise)
      const client = fakeClient({ previewSegment })
      renderBuilder(client)

      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // A further edit before the first request has landed -- this is the
      // "tree has changed again" the invariant names. `answerIdRef` moves
      // right here, before request 2 is even issued.
      await userEvent.type(
        within(screen.getByTestId('condition-0')).getByRole('textbox', { name: /key/i }),
        'X',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(2))

      // Landing order does not track issue order -- resolve the NEWER
      // request first.
      await act(async () => {
        p2.resolve({ ...PREVIEW, person_count: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('999')
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()

      // The OLDER response lands late -- discarded outright: no count
      // change, and Run stays usable rather than getting stuck by a
      // `.finally` that thinks IT was the most recent call.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('999')
      expect(screen.queryByText('111')).toBeNull()
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    })
  })

  // Pins `runPreview`'s `.finally` guard in ISOLATION from the test above --
  // that one always resolves the NEWER call first, so `previewing` would
  // already read false by the time the older call's own `.finally` runs
  // even WITHOUT this guard (verified: a mutation dropping the `.finally`
  // guard alone passed the test above unnoticed). Here the OLDER call
  // settles FIRST, while the newer one is still open, which is the only
  // ordering that actually exercises it.
  it('does not re-enable Run when an older call settles before a still-open newer call', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const p2 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise)
      const client = fakeClient({ previewSegment })
      renderBuilder(client)

      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      await userEvent.type(
        within(screen.getByTestId('condition-0')).getByRole('textbox', { name: /key/i }),
        'X',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(2))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // The OLDER call (request 1) settles first, while request 2 is still
      // open.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // Only now, with the truly most recent call settled, may Run re-enable.
      await act(async () => {
        p2.resolve({ ...PREVIEW, person_count: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
      expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('999')
    })
  })

  const BEHAVIOUR_LAST: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'behavior',
        event: 'import_started',
        aggregate: 'count',
        window: { kind: 'last', n: 7, unit: 'days' },
        operator: '>=',
        value: 1,
      },
    ],
  }

  // Every stale-response test above issues a
  // REPLACEMENT request for the newer state (a second edit, or navigating
  // to a segment that itself auto-previews) -- collapsing `answerIdRef` and
  // `requestIdRef` into a single shared ref still passed every one of them.
  // The case that actually distinguishes two counters from one is a
  // request ABANDONED by an edit that issues NO replacement at all: a
  // cheap tree's debounced preview is still in flight when the operator
  // flips a behaviour's window to `ever`, making the tree costly -- the
  // debounce effect's own early return (`hasCostWarning`) means no second
  // request is ever issued. Under a single shared ref, that edit would
  // invalidate the FIRST request's own identity too, so its `.finally`
  // never fires and Run is stuck disabled forever, with no later call ever
  // coming along to clear it -- the exact funnels defect this design
  // exists to prevent (this component's own doc comment).
  it('re-enables Run when an abandoned request lands late, even though no replacement request was ever issued', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise)
      const client = fakeClient({
        segment: vi.fn(async () => ({ ...SEGMENT, filter: BEHAVIOUR_LAST })),
        previewSegment,
      })
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')

      // One real edit to a still-cheap tree -- dirties it and starts the
      // debounce without changing what makes it cheap.
      const negate = within(screen.getByTestId('condition-0')).getByRole('button', {
        name: /negate/i,
      })
      await userEvent.click(negate)
      await userEvent.click(negate)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // The tree becomes COSTLY before the first request lands -- a real
      // edit that issues no replacement request of its own.
      const windowSelect = within(screen.getByTestId('condition-0')).getByRole('combobox', {
        name: /^window$/i,
      })
      await userEvent.selectOptions(windowSelect, 'ever')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(previewSegment).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/scans all history/i)).toBeInTheDocument()

      // The abandoned request lands late -- discarded (it answers a tree
      // that no longer exists), but Run must re-enable.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
      expect(screen.queryByTestId('segment-preview-count')).toBeNull()
    })
  })

  it('an explicit Run previews a tree carrying a cost warning', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
  })

  // --- The count's own instant. A preview can be served from the server's
  // cache up to its TTL, and the response deliberately carries the STORED
  // `as_of` on a hit so a client can say so -- a bare number cannot be told
  // apart from a live one. `FunnelBuilder`/`FunnelDetail` already render
  // exactly this field through `formatRelative`; this screen discarded it.

  it('renders the instant a count was computed at, beside the count', async () => {
    await withFakeTimers(async () => {
      // Pinned by VALUE, not by shape: two hours after `PREVIEW.as_of`, so
      // a render that reached for `new Date()` (or for the moment the
      // request was issued) instead of the response's own `as_of` reads
      // "just now" and fails here.
      vi.setSystemTime(new Date('2026-08-16T02:00:00.000Z'))
      const client = fakeClient()
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')
      await userEvent.click(screen.getByRole('button', { name: /run/i }))
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
      const asOf = screen.getByTestId('segment-preview-as-of')
      expect(asOf).toHaveTextContent('2 hours ago')
      expect(asOf).not.toHaveTextContent('just now')
    })
  })

  it('a count left standing for a tree that has since changed says so, rather than only dimming', async () => {
    // The transition the "click Run to see a count" sentence can never
    // cover, because it renders only when there has NEVER been a result: a
    // count lands, the tree is then edited, and the number stays on screen
    // at half opacity answering a tree the operator can no longer see. A
    // costly tree is used throughout so no auto-preview can race in and
    // replace the result while the assertion runs.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
    expect(screen.queryByTestId('segment-preview-stale-note')).toBeNull()

    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    expect(screen.getByTestId('segment-preview')).toHaveAttribute('data-stale', 'true')
    // The count is still there -- this is not "hide it", it is "say what it
    // is". A dimmed number with no words is the thing being fixed.
    expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('42')
    expect(screen.getByTestId('segment-preview-stale-note')).toHaveTextContent(/earlier version/i)
  })
})

// --- Every tree fixture above has a `group` at its root, and that is the
// shape being broken here. `SegmentQuery.filter` is the whole `FilterNode`
// union, so a segment authored by the CLI can legally carry a bare leaf, or
// a `not`, at its root. The editor wraps such a root in a one-child `and`
// group to render it -- and while that wrapping happened invisibly inside
// `TreeEditor`, this screen computed `costWarnings` against the UN-wrapped
// tree it still held, so every warning path was exactly one segment shorter
// than the `ConditionRow` it named and `warningsAt`'s exact-length match
// dropped all of them. The operator was told the segment was expensive and
// shown nothing about which condition. The fix is one tree: `normaliseRoot`
// is applied where a tree ENTERS this screen's state, and `TreeEditor` takes
// a `Group`, so there is no second tree to disagree with.

describe('SegmentBuilder -- a root that is not a group', () => {
  const everBehaviour: FilterNode = {
    kind: 'behavior',
    event: 'purchase',
    aggregate: 'count',
    window: { kind: 'ever' },
    operator: '>=',
    value: 1,
  }
  const bareTrait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

  it('renders a bare-leaf root cost warning against the condition row that names it', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: everBehaviour })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  it('renders a not-rooted tree cost warning against the condition row that names it', async () => {
    // A second shape, one level deeper again: `not` never consumes a path
    // segment in the editor's addressing, so the negated behaviour leaf is
    // still `condition-0`.
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: { kind: 'not', child: everBehaviour } as FilterNode,
      })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  it('a group root still renders its warning against the row that names it (the control)', async () => {
    // Passes today, and must keep passing -- it is what makes the two above
    // a PATH defect rather than a warnings defect.
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: { kind: 'group', op: 'and', children: [everBehaviour] } as FilterNode,
      })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  // --- The save path. Normalising on entry must not make a stored bare-leaf
  // tree silently acquire a wrapper group the operator never asked for.

  it('opening a bare-leaf-rooted segment and saving it untouched sends nothing at all', async () => {
    // `originalRoot` holds the SAME normalised tree the editor renders, so
    // there is nothing to differ and no request to make -- the stored tree
    // keeps its shape unless the operator actually edits it.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: bareTrait })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
  })

  it('editing a bare-leaf-rooted segment saves the wrapped shape the editor showed', async () => {
    // The accepted behaviour change, pinned rather than left implicit: an
    // EDITED bare-leaf root is written back wrapped in a one-child `and`,
    // which compiles identically to the bare child. This was already true
    // before the tree was normalised on entry -- every edit came back up
    // from the editor wrapped -- so what is new is only that an UNTOUCHED
    // segment now provably sends nothing (the test above).
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: bareTrait })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    const call = client.updateSegmentTree.mock.calls[0]
    if (!call) throw new Error('updateSegmentTree was not called')
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'not', child: bareTrait }],
      },
    })
  })
})

// --- Every fixture above mounts ONE builder against ONE segment in ONE
// project and never changes either while mounted; `renderEdit` mutates the
// client's mock BEFORE rendering. There was no test in this file where the
// load effect ran twice, which is the shape being broken here.
//
// The invariant: this screen's state must never describe a segment other
// than the one addressed by (`activeId`, `editId`) right now. Writing state
// only on a SUCCESSFUL load broke it in four places at once -- a failing
// re-fetch, a 404 after a project switch, edit -> edit, and edit -> the
// create route, which React reconciles onto the same component instance --
// and `handleSave` then combined the previous segment's tree with the id in
// the URL and the currently active project.
//
// The routes below carry NO `key`, deliberately. `AppRouter` gives its two
// `SegmentBuilder` routes distinct keys as defence in depth, but a key is
// one edit away from being removed; these tests hold the screen to the
// harder case, where the instance survives every navigation.

const PROJECTS_TWO = [
  ...PROJECTS,
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

/** The header project switcher, reduced to the one thing it does that
 * matters here -- it is reachable from every screen, including an open
 * segment editor. */
function SwitchProject() {
  const { setActiveId } = useProject()
  return (
    <button type="button" onClick={() => setActiveId(2)}>
      switch project
    </button>
  )
}

function GoTo(props: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(props.to)}>
      {props.label}
    </button>
  )
}

/** Like `renderBuilder`, but the project and the route can both change
 * while the builder stays mounted. */
function renderLiveBuilder(client: ApiClient, initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ProjectProvider projects={PROJECTS_TWO} initialId={1}>
        <SwitchProject />
        <GoTo to={segmentEditPath(8)} label="go to segment 8" />
        <GoTo to={ROUTES.segmentNew} label="go to create" />
        <Routes>
          <Route path={ROUTES.segmentNew} element={<SegmentBuilder client={client} />} />
          <Route path="/segments/:id/edit" element={<SegmentBuilder client={client} />} />
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
          <Route path="/segments/:id" element={<p>segment detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('SegmentBuilder -- the identity its state describes', () => {
  it('a project switch whose fetch 404s leaves nothing of the previous project segment on screen', async () => {
    const client = fakeClient({
      segment: vi.fn(async (projectId: number) => {
        if (projectId !== 1) throw new ApiError(404, 'not_found')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    expect(await screen.findByTestId('condition-0')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Paying customers')

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)

    // Not merely "an error is shown above it" -- the previous project's
    // segment is GONE. It was fully editable here, one click from being
    // written to the same id under a different project.
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('refuses to save a segment it never loaded, even once the form has been filled in by hand', async () => {
    // The reset above already leaves an empty, unsaveable form -- so this
    // fills in a name and a condition by hand, which is two clicks away
    // after any failed load, leaving `canSave`'s completed-load term as the
    // only thing between it and a cross-project write.
    const client = fakeClient({
      segment: vi.fn(async (projectId: number) => {
        if (projectId !== 1) throw new ApiError(404, 'not_found')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await screen.findByRole('alert')

    await userEvent.type(screen.getByLabelText(/name/i), 'Anything at all')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    // Asserted on the REQUEST as well as the control -- a screen that
    // disables the wrong button but still fires the call would pass a
    // control-only test.
    await userEvent.click(save)
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('edit -> edit with a failing second fetch never leaves the first segment tree on screen', async () => {
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => {
        if (id !== 7) throw new ApiError(500, 'server_error')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    expect(await screen.findByTestId('condition-0')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('edit -> the create route opens an empty form, never the previous segment pre-filled', async () => {
    const client = fakeClient()
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')

    await userEvent.click(screen.getByRole('button', { name: /go to create/i }))
    expect(await screen.findByRole('heading', { name: /create segment/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()

    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('a count run for the previous segment is not left standing against the next one', async () => {
    // The same invariant applied to the derived state a save does not read:
    // a preview belongs to the tree that answered it, and that tree is gone.
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => ({ ...SEGMENT, id })),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    await waitFor(() => expect(client.segment).toHaveBeenCalledTimes(2))
    await screen.findByTestId('condition-0')
    expect(screen.queryByTestId('segment-preview-count')).toBeNull()
  })
})
