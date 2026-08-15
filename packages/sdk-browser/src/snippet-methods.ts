/**
 * The methods the install snippet's stub queues, and the single source
 * `lyraflow snippet` builds that stub from. A public method absent from
 * this list is silently dropped when called before the async bundle
 * loads; a listed method with no `drainSnippetQueue` case is queued and
 * then discarded. Both are invisible at runtime -- no error, no event --
 * so both are pinned by snippet-methods.test.ts rather than trusted.
 *
 * Its own module, deliberately, NOT a value living only in `index.ts`
 * (IMPORTANT 4 from the whole-branch review). `index.ts`'s root barrel
 * ends with a bare top-level `installGlobal()` call -- see that function's
 * own docstring -- which stamps `window.lyraflow` the instant the module
 * evaluates, with no call required. `SnippetSection.tsx` (the web UI) used
 * to import `SNIPPET_METHODS` from that root barrel, which pulled
 * `installGlobal()`'s side effect into the ADMIN bundle: the admin origin
 * is also the ingest origin, so loading the admin UI silently defined
 * `window.lyraflow` there too, and the whole tracking SDK rode along with
 * it. Nothing about that throws, which is exactly why it stayed invisible
 * -- `build-output.test.ts` can only catch a module-scope THROW, so it is
 * structurally blind to a side effect that merely succeeds. A caller that
 * wants only this constant now imports THIS module's own exports subpath
 * (`@lyraflow/sdk-browser/snippet-methods.js`, see `package.json`'s
 * `exports` map), the same discipline `SnippetSection.tsx` already uses for
 * `@lyraflow/core/snippet/build.js` instead of that package's own root
 * barrel, and for the same reason.
 */
export const SNIPPET_METHODS = [
  'init',
  'track',
  'page',
  'identify',
  'consent',
  'reset',
  'flush',
] as const
