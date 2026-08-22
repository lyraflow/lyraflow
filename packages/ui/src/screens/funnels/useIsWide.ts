import { useEffect, useState } from 'react'

/**
 * The width at which the horizontal flow has room to say anything.
 *
 * Tailwind's `md`. Below it, eight steps share the viewport: at 390px that
 * is 48px per step, which holds neither an event name, nor a count, nor a
 * percentage. The narrow answer is the stacked bars, which were built for
 * exactly that shape and are already tested.
 */
const WIDE_QUERY = '(min-width: 768px)'

/**
 * Whether the viewport is wide enough for the horizontal funnel flow.
 *
 * **Defaults to `false`**, and that default is the whole safety story. jsdom
 * implements no `matchMedia` at all -- `ThemeToggle` learned this and calls
 * it optionally for the same reason -- and a server-rendered or
 * test-rendered tree therefore gets the STACKED BARS, the rendering that
 * works at every width and has tests of its own. Getting the fallback
 * backwards would mean a chart that silently renders into 48px slots
 * wherever the API is missing.
 *
 * Subscribes rather than reading once: a window resized across the
 * breakpoint, or a phone rotated, must switch renderings. `addEventListener`
 * with a `change` listener, not the deprecated `addListener`, and optional
 * throughout so an environment with a partial `matchMedia` shim degrades to
 * the bars instead of throwing during render.
 */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(false)

  useEffect(() => {
    const query = window.matchMedia?.(WIDE_QUERY)
    if (query == null) return
    setWide(query.matches)
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  return wide
}
