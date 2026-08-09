/**
 * The quota decision, kept pure and free of any database so the arithmetic
 * that decides whether to refuse a customer's events is testable in
 * isolation -- and so the ingest route contains no arithmetic of its own.
 *
 * `null` means unlimited, which is the default after migration 011 and the
 * value every project carries on upgrade. Callers short-circuit on it before
 * reading usage at all: an unlimited project must not pay a Postgres round
 * trip for a limit it does not have.
 *
 * ONLY ACCEPTED EVENTS ARE COUNTED, and that is a security property rather
 * than a nicety. If rejections counted, an attacker sending malformed
 * payloads would exhaust a project's quota without storing a single byte --
 * cheaper than the flood this exists to stop. `persisted` and `pending` must
 * both be accepted-event counts; see counters.ts's `persistedAccepted`.
 *
 * `persisted` and `pending` are trusted only as far as this function can
 * verify: each must be a finite, non-negative number. Zero is legal and is
 * the ordinary state of a project that has accepted nothing yet -- but NaN,
 * Infinity, and negative values are refused rather than silently compared.
 * That refusal exists because `>=` fails OPEN against them: `NaN >= quota`
 * and `-1 >= quota` are both `false`, so an unguarded caller reads "not over
 * quota" from a value that is not a count at all. That is precisely the
 * dangerous direction described above -- quota enforcement doing nothing --
 * and the typical source is a Postgres read for a project's first event of a
 * month, before any counter row exists: `Number(row?.count)` on a missing
 * row is exactly `NaN`. A thrown error here is a loud failure a caller
 * cannot ignore; a silently-false quota check is not.
 */
export function isOverQuota(persisted: number, pending: number, quota: number | null): boolean {
  if (quota === null) return false
  if (!Number.isInteger(quota) || quota <= 0) {
    throw new Error(`refusing to evaluate quota: quota ${quota} is not a positive integer`)
  }
  if (!Number.isFinite(persisted) || persisted < 0) {
    throw new Error(
      `refusing to evaluate quota: persisted ${persisted} is not a finite, non-negative number`,
    )
  }
  if (!Number.isFinite(pending) || pending < 0) {
    throw new Error(
      `refusing to evaluate quota: pending ${pending} is not a finite, non-negative number`,
    )
  }
  return persisted + pending >= quota
}
