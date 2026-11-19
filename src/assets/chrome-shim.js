/**
 * Firefox compatibility shim injected by crx2xpi.
 *
 * Chromium MV3 extensions call the `chrome.*` API with `await` because Chrome
 * resolves those calls as promises. Firefox keeps the `chrome` namespace
 * callback-only and exposes promise-based calls only through `browser`, so
 * every `await chrome.*` call silently resolves to `undefined` and the
 * extension's logic breaks without any visible error.
 *
 * Firefox's `browser` namespace supports both calling styles (promise when no
 * callback is passed, callback otherwise) and covers the same API surface as
 * `chrome`, so aliasing `chrome` to `browser` restores Chromium semantics
 * without touching the original extension code. On Chromium the `browser`
 * global does not exist and this shim is a no-op, which keeps the converted
 * package harmless if it is ever loaded back into Chrome.
 */
if (typeof browser !== 'undefined' && typeof chrome !== 'undefined' && chrome !== browser) {
  try {
    globalThis.chrome = browser;
  } catch {
    // A frozen `chrome` global cannot be aliased. Callback-style calls keep
    // working in that case; promise-style calls cannot be supported there.
  }
}
