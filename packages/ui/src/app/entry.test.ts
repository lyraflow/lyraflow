import { describe, expect, it } from 'vitest'
import { sharedTokenOf } from './entry.js'

const TOKEN = 'A'.repeat(43)

describe('sharedTokenOf', () => {
  it('matches exactly /shared/<43 base64url chars>, with or without a trailing slash', () => {
    expect(sharedTokenOf(`/shared/${TOKEN}`)).toBe(TOKEN)
    expect(sharedTokenOf(`/shared/${TOKEN}/`)).toBe(TOKEN)
  })

  // The negative list is the point of this test, not a formality. This
  // function is what decides whether the session check runs at all, so a
  // pattern that is one character too loose mounts the viewer page over a
  // path the router owns -- and one that is too tight sends a person
  // holding a valid link to the login form.
  it('matches nothing else', () => {
    for (const p of [
      '/',
      '/shared',
      '/shared/',
      `/shared/${TOKEN}x`,
      `/shared/${'A'.repeat(42)}`,
      `/dashboards/shared/${TOKEN}`,
      `/shared/${TOKEN}/edit`,
      '/shared/../feed',
    ]) {
      expect(sharedTokenOf(p)).toBeNull()
    }
  })

  // The token alphabet is base64url's, because that is what the server
  // mints (`crypto.randomBytes(32).toString('base64url')`). A `+` or a `/`
  // in a candidate is base64's alphabet, not this one, and must not match:
  // it could only have been typed or rewritten by something on the way.
  it('rejects a 43-character string outside the base64url alphabet', () => {
    expect(sharedTokenOf(`/shared/${'A'.repeat(42)}+`)).toBeNull()
    expect(sharedTokenOf(`/shared/${'A'.repeat(42)}=`)).toBeNull()
  })
})
