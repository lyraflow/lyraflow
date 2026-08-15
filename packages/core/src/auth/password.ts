import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// `scrypt` has two overloads (with and without an options object) and no
// `__promisify__` companion in @types/node, so `promisify(scrypt)` resolves
// to the first (3-arg) overload's type and rejects the options object at
// compile time even though it is accepted at runtime. Pin the type by hand
// to the overload this module actually calls.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * scrypt from `node:crypto`, not argon2id.
 *
 * argon2id is the better algorithm and every implementation of it is a
 * native module. This image must build on whatever a self-hoster runs, and
 * a password hash is not worth a build toolchain in the Dockerfile. scrypt
 * is a legitimate password KDF, is in Node core, and needs nothing.
 *
 * N=16384, r=8, p=1 is the classic interactive-login parameter set: roughly
 * 16 MiB of memory and a few tens of milliseconds per hash. Node's default
 * `maxmem` is 32 MiB, which N=16384/r=8 fits under; raising N without
 * raising `maxmem` fails at runtime rather than at review, so both move
 * together or neither does.
 */
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16

/**
 * The digest is self-describing -- `scrypt$N$r$p$salt$hash`, both tails hex
 * -- so that raising the parameters later can verify old rows with their
 * own stored values instead of needing a migration or a flag day.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length === 0) throw new Error('refusing to hash an empty password')
  const salt = randomBytes(SALT_BYTES)
  const derived = (await scryptAsync(plain, salt, KEYLEN, { N, r: R, p: P })) as Buffer
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/**
 * NEVER THROWS, and that is a behavioural requirement rather than defensive
 * habit. Its only caller is the login route, and an exception there becomes
 * app.ts's catch-all `503 {"error":"unavailable"}` -- so a single
 * hand-edited or truncated `password_hash` column would present to an
 * operator as a server outage, and they would go looking at Postgres and
 * ClickHouse rather than at the one row that is actually wrong. Every
 * malformed stored value is a `false`.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  // `stored` is typed as `string`, but the value that reaches this function
  // at runtime came out of a database column, not the type checker. A NULL
  // `password_hash` -- an admin row that never had one set, a bad migration,
  // a hand-edited value -- arrives here as `null`, and `null.split` throws
  // before the try/catch below ever gets a chance to run.
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 1 || r <= 0 || p <= 0) return false
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false
  if (hashHex.length % 2 !== 0 || saltHex.length % 2 !== 0) return false

  const expected = Buffer.from(hashHex, 'hex')
  try {
    const derived = (await scryptAsync(plain, Buffer.from(saltHex, 'hex'), expected.length, {
      N: n,
      r,
      p,
    })) as Buffer
    // Lengths are equal by construction (`expected.length` was the keylen
    // asked for), but timingSafeEqual throws on a mismatch rather than
    // returning false, so the guard stays.
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
