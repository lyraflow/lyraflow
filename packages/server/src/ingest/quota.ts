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
 */
export function isOverQuota(persisted: number, pending: number, quota: number | null): boolean {
  if (quota === null) return false
  if (!Number.isInteger(quota) || quota <= 0) {
    throw new Error(`refusing to evaluate quota: ${quota} is not a positive integer`)
  }
  return persisted + pending >= quota
}
