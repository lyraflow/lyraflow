import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('hashPassword', () => {
  it('produces a self-describing digest that verifies', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  // Every one of these reaches verifyPassword from a real code path: a row
  // written by an older build, a truncated column, a hand-edited value. None
  // may throw, and none may return true -- a throw from the login route
  // becomes app.ts's catch-all 503, which reads as an outage rather than a
  // bad password.
  it.each([
    ['empty', ''],
    ['no algorithm prefix', 'deadbeef$deadbeef'],
    ['unknown algorithm', 'bcrypt$1$2$3$deadbeef$deadbeef'],
    ['too few fields', 'scrypt$16384$8$1$onlysalt'],
    ['non-numeric cost', 'scrypt$N$8$1$aabb$ccdd'],
    ['non-hex digest', 'scrypt$16384$8$1$aabb$zzzz'],
  ])('returns false for a malformed stored value: %s', async (_name, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false)
  })

  // `stored` is typed as `string`, but the type checker cannot stop a NULL
  // database column, or a bad deserialize, from putting `null`/`undefined`
  // in that slot at runtime. Cast past the type to exercise exactly that.
  it('returns false when the stored value is not a string at runtime', async () => {
    await expect(verifyPassword('anything', null as unknown as string)).resolves.toBe(false)
    await expect(verifyPassword('anything', undefined as unknown as string)).resolves.toBe(false)
  })

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(/empty/i)
  })
})
