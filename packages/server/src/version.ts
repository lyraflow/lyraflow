/**
 * The release this server was built from, served by `GET /v1/meta` and shown
 * on the Settings screen.
 *
 * A hand-written literal, matching `CLI_VERSION` and the SDK's `VERSION`.
 * The built server runs out of `dist/`, so reading its own `package.json` at
 * runtime would depend on what the image copies beside the output; a literal
 * does not.
 *
 * Bump this by hand whenever packages/server/package.json's "version"
 * changes — `version.test.ts` fails if you forget, which is the only thing
 * keeping the two in step.
 */
export const SERVER_VERSION = '0.12.0'
