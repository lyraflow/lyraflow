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

  it('still shows the answer to the query that is current', async () => {
    const schemaProperties = vi.fn(async (_p: number, _e: string | undefined, q: string) =>
      q === 'ut' ? [prop('utm_test_variant')] : [prop('path')],
    )
    const client = { schemaProperties } as unknown as ApiClient

    render(<Harness client={client} query="ut" />)
    await vi.waitFor(() => expect(names()).toEqual(['utm_test_variant']))
  })
})
