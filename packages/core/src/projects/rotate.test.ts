import { describe, expect, it } from 'vitest'
import type { ProjectStore } from './create.js'
import { rotateWriteKey } from './rotate.js'

interface Call {
  text: string
  params: unknown[]
}

function fakeStore(response: { rows: unknown[] }): { store: ProjectStore; calls: Call[] } {
  const calls: Call[] = []
  const store: ProjectStore = {
    async query(text: string, params: unknown[]) {
      calls.push({ text, params })
      return response
    },
  }
  return { store, calls }
}

describe('rotateWriteKey', () => {
  it('issues a fresh wk_ key and retires the old one with the given grace', async () => {
    const now = new Date('2026-09-03T00:00:00.000Z')
    const graceMs = 60_000
    const expiresAt = new Date(now.getTime() + graceMs)
    const { store, calls } = fakeStore({
      rows: [
        {
          write_key: 'wk_00000000000000000000000000000000',
          previous_write_key: 'wk_old',
          previous_write_key_expires_at: expiresAt,
        },
      ],
    })

    const result = await rotateWriteKey(store, 1, graceMs, now)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('expected one query call')
    const { text, params } = call
    // previous_write_key is set FROM the current column value (`write_key`),
    // not from a parameter -- it is the key being replaced, so it must be
    // read out of the row rather than passed in.
    expect(text).toMatch(/previous_write_key\s*=\s*CASE[\s\S]*ELSE\s+write_key\s+END/)
    expect(params[0]).toBe(1)
    expect(params[1]).toEqual(expiresAt)
    expect(params[2]).toMatch(/^wk_[0-9a-f]{32}$/)

    expect(result).toEqual({
      writeKey: 'wk_00000000000000000000000000000000',
      previousWriteKey: 'wk_old',
      previousWriteKeyExpiresAt: expiresAt,
    })
  })

  it('a grace of zero is a hard swap: previous key and expiry are null', async () => {
    const { store, calls } = fakeStore({
      rows: [
        {
          write_key: 'wk_11111111111111111111111111111111',
          previous_write_key: null,
          previous_write_key_expires_at: null,
        },
      ],
    })

    const result = await rotateWriteKey(store, 1, 0)

    const call = calls[0]
    if (!call) throw new Error('expected one query call')
    expect(call.params[1]).toBeNull()
    expect(result).toEqual({
      writeKey: 'wk_11111111111111111111111111111111',
      previousWriteKey: null,
      previousWriteKeyExpiresAt: null,
    })
  })

  it('returns null for a project that does not exist', async () => {
    const { store } = fakeStore({ rows: [] })

    const result = await rotateWriteKey(store, 999, 1000)

    expect(result).toBeNull()
  })

  it('never reuses the key it is replacing', async () => {
    const calls: unknown[][] = []
    const store: ProjectStore = {
      async query(_text: string, params: unknown[]) {
        calls.push(params)
        const writeKey = params[2] as string
        return {
          rows: [
            { write_key: writeKey, previous_write_key: null, previous_write_key_expires_at: null },
          ],
        }
      },
    }

    const first = await rotateWriteKey(store, 1, 0)
    const second = await rotateWriteKey(store, 1, 0)

    expect(first?.writeKey).toBeTruthy()
    expect(second?.writeKey).toBeTruthy()
    expect(first?.writeKey).not.toBe(second?.writeKey)
  })

  it('rejects a negative or non-integer grace with a RangeError', async () => {
    const { store } = fakeStore({ rows: [] })

    await expect(rotateWriteKey(store, 1, -1)).rejects.toThrow(RangeError)
    await expect(rotateWriteKey(store, 1, 1.5)).rejects.toThrow(RangeError)
  })
})
