/**
 * The Lyraflow SDKs that run on a server, and are therefore never bots.
 *
 * An EXPLICIT ALLOWLIST rather than a `lyraflow-` prefix rule, for two
 * reasons. A prefix rule grants exemption to any name someone invents, so
 * adding an SDK stops being a decision anyone reviews. And it would match
 * `lyraflow-browser`, which must stay filtered -- a crawler executing JS on
 * an instrumented page sends exactly what a real visitor's browser sends,
 * and the User-Agent check is the only thing telling them apart.
 *
 * This list is NOT a security control. The write key ships inside the
 * browser bundle, so any client can claim to be `lyraflow-python`. It does
 * not need to resist that: what the bot filter removes is incidental traffic
 * -- crawlers, uptime monitors, link-preview fetchers -- and none of those
 * will ever declare a library at all.
 */
export const SERVER_SIDE_LIBRARIES: readonly string[] = [
  'lyraflow-node',
  'lyraflow-python',
  'lyraflow-php',
]

/** Case-sensitive: these are literals Lyraflow's own SDKs send, not user input. */
export function isServerSideLibrary(name: string | undefined): boolean {
  if (!name) return false
  return SERVER_SIDE_LIBRARIES.includes(name)
}
