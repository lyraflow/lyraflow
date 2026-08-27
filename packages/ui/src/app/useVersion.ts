import { useEffect, useState } from 'react'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'

/**
 * The release the server is running, from `GET /v1/meta`.
 *
 * Shared by the two places that show it: the sidebar's footer and the
 * Settings screen's Install card. They fetch separately rather than sharing
 * one result -- `Shell` renders `children` that `AppRouter` has already
 * constructed, so it cannot pass a value down, and threading one through
 * context to spare a single request on a screen an operator opens
 * occasionally is a worse trade than making it twice. `dedupeInFlight` does
 * not apply: it shares CONCURRENT requests, and these two are not (one on
 * app load, one on navigating to Settings).
 *
 * `failed` is separate from `version === null` because the two mean
 * different things to a caller: not-yet-arrived and will-never-arrive. The
 * sidebar renders nothing for either; the card distinguishes them, showing
 * a placeholder for the first and an explanation for the second.
 */
export function useVersion(
  client: ApiClient,
  onUnauthorized?: () => void,
): { version: string | null; failed: boolean } {
  const [version, setVersion] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    client
      .meta()
      .then((meta) => {
        if (!cancelled) setVersion(meta.version)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A 401 means the session is gone, and callers that can route back to
        // login say so instead of reporting a failed fetch -- which would
        // read as a transient hiccup forever, with no way out.
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, onUnauthorized])

  return { version, failed }
}
