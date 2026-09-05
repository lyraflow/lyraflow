/**
 * Decides, before React mounts, whether this page is the viewer surface.
 *
 * This lives outside every component because the decision has to be made
 * BEFORE anything renders: `App` calls `GET /v1/auth/session` in its first
 * effect and shows the login form on the 401 that a person holding a share
 * link will always get. Choosing the entry point from the pathname in
 * `main.tsx` is what keeps that request from ever being made on the shared
 * page -- a check inside `App` would already have sent it.
 *
 * The token shape is the server's `SHARE_TOKEN_PATTERN` (32 random bytes as
 * base64url, so 43 characters of `[A-Za-z0-9_-]`), restated here for the
 * same reason the tile ceilings are restated in `tileRequest.ts`: this side
 * must not mount a surface the server will refuse, and must not send an
 * arbitrary path segment to it either. Anything else is the ordinary app,
 * which will show the login screen.
 *
 * Anchored at both ends, so `/shared/<token>/edit` and
 * `/dashboards/shared/<token>` are not the viewer page; the optional
 * trailing slash is the one variation a person's browser or a link
 * shortener may add on its own.
 */
export const SHARED_PATH_PATTERN = /^\/shared\/([A-Za-z0-9_-]{43})\/?$/

export function sharedTokenOf(pathname: string): string | null {
  return SHARED_PATH_PATTERN.exec(pathname)?.[1] ?? null
}
