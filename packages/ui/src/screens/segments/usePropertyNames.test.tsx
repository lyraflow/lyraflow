import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import type { SchemaProperty } from '../../api/types.js'
import { usePropertyNames } from './usePropertyNames.js'

function prop(name: string): SchemaProperty {
  return { name, kind: 'string' }
}

/** The hook and nothing else. Both `PropertyCombobox` and `FieldCombobox`
 * share it, so the ordering guarantee belongs here rather than in whichever
 * popup happened to surface the bug. */
function Harness(props: { client: ApiClient; query: string }) {
  const { options } = usePropertyNames({
    client: props.client,
    projectId: 1,
    event: '$page',
    query: props.query,
  })
  return (
    <ul>
      {options.map((o) => (
        <li key={o}>{o}</li>
      ))}
    </ul>
  )
}

const names = () => screen.queryAllByRole('listitem').map((li) => li.textContent)

describe('usePropertyNames', () => {
  // The failure this pins was a flaky CI run, not a report: typing is fast
  // enough locally that the first lookup is cancelled before it is ever sent,
  // and slow enough on a loaded machine that it is in flight when the second
  // one answers. An operator sees a suggestion list that does not match what
  // they typed.
  it('ignores a lookup that a newer query has already superseded', async () => {
    let releaseFirst: (list: SchemaProperty[]) => void = () => {}
    const schemaProperties = vi.fn((_p: number, _e: string | undefined, q: string) => {
      // The empty query is the one that hangs -- it is also the broadest, so
      // its answer is the one that does the damage if it lands late.
      if (q === '') {
        return new Promise<SchemaProperty[]>((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve([prop('utm_test_variant')])
    })
    const client = { schemaProperties } as unknown as ApiClient

    const view = render(<Harness client={client} query="" />)
    // Wait past the debounce so the first lookup is genuinely SENT, not
    // merely scheduled -- a cancelled timer is the case that already worked.
    await vi.waitFor(() => expect(schemaProperties).toHaveBeenCalledTimes(1))

    view.rerender(<Harness client={client} query="utm" />)
    await vi.waitFor(() => expect(schemaProperties).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(names()).toEqual(['utm_test_variant']))

    // The first lookup finally answers, for a query this field left long ago.
    await act(async () => {
      releaseFirst([prop('path'), prop('plan')])
    })

    expect(names()).toEqual(['utm_test_variant'])
  })

  // The sibling of the test above, and the half that the `superseded` guard
  // structurally cannot cover: this lookup is not in flight when it is
  // overtaken, it has already ANSWERED. Its names sit in state, correct for
  // a query nobody is typing any more, and stay on screen for the next
  // debounce plus a round trip. The guard discards a late answer; nothing
  // was discarding an early one.
  //
  // This is the defect behind the 2026-09-05 CI failure, where the empty
  // query answered before the first keystroke landed and `path` and `plan`
  // were offered for the text `utm`.
  it("does not offer an earlier query's answer while the current one is in flight", async () => {
    const schemaProperties = vi.fn((_p: number, _e: string | undefined, q: string) => {
      if (q === '') return Promise.resolve([prop('path'), prop('plan'), prop('utm_test_variant')])
      // The current query never answers, so what is on screen is entirely
      // whatever the earlier one left behind.
      return new Promise<SchemaProperty[]>(() => {})
    })
    const client = { schemaProperties } as unknown as ApiClient

    const view = render(<Harness client={client} query="" />)
    await vi.waitFor(() => expect(names()).toEqual(['path', 'plan', 'utm_test_variant']))

    view.rerender(<Harness client={client} query="utm" />)
    await vi.waitFor(() => expect(schemaProperties).toHaveBeenCalledTimes(2))

    // `startsWith` on the trimmed text -- the SAME rule the server applies,
    // so this can only drop a name the server would not have returned for
    // the query now in the field.
    expect(names()).toEqual(['utm_test_variant'])
  })

  it('narrows by the raw trimmed text, matching the server rather than the attribute half', async () => {
    // The route filters with ClickHouse `startsWith(property_key, q)` on the
    // text as sent -- case-sensitive. Folding case here would offer a name
    // the server had already declined to return, which reads as a suggestion
    // that vanishes on the next keystroke.
    const schemaProperties = vi.fn(async () => [prop('Plan'), prop('plan_tier')])
    const client = { schemaProperties } as unknown as ApiClient

    render(<Harness client={client} query="pl" />)
    await vi.waitFor(() => expect(names()).toEqual(['plan_tier']))
  })

  it('still shows the answer to the query that is current', async () => {
    const schemaProperties = vi.fn(async (_p: number, _e: string | undefined, q: string) =>
      q === 'ut' ? [prop('utm_test_variant')] : [prop('path')],
    )
    const client = { schemaProperties } as unknown as ApiClient

    render(<Harness client={client} query="ut" />)
    await vi.waitFor(() => expect(names()).toEqual(['utm_test_variant']))
  })
})
