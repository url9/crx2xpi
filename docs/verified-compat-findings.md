# Verified compatibility findings (real-browser corpus)

Every entry in this file was observed in a **real Firefox run**, not derived
from documentation. Firefox version: ESR 153.7.0 (Xvfb, Marionette-driven,
one isolated profile per extension). These entries are the corpus for future
`src/core/diagnostics.ts` catalogue iterations: a finding is only promoted to
a catalogue rule after it has been reproduced at runtime.

## Extensions verified functionally (converted by crx2xpi)

| Extension | Functional criterion | Result |
| --- | --- | --- |
| CookieMop | Cookies for a site are deleted after the **last** tab on that site closes (≤ 60 s) | PASS |
| Open Stay Focused | Zero-budget group on `127.0.0.1` redirects the tab to `ui/blocked.html?reason=quota` | PASS |
| Local iTab | `newtab.html` renders the `#dashboard` UI | PASS |
| Cursorfly | `record.html` UI renders and the background answers a `ping` message | PASS |
| Alt Text Auto-Fill | `onInstalled` wrote settings; "Generate Alt Text for This Image" appears in the **real** (trusted-input) context menu | PASS |
| Dark Reader | Page darkens; popup toggle OFF reverts to light; toggle ON darkens again | PASS |

Two methodology notes from that round, so future tests do not repeat them:

- `browser.menus.getAll()` is **not implemented in Firefox** — the namespace
  exposes `create`/`update`/`remove`/`removeAll`/`onClicked` only. Probe menu
  registration by opening the native context menu (trusted
  `WebDriver:PerformActions` right-click) and inspecting
  `#contentAreaContextMenu`, not by calling `getAll()`.
- CookieMop deletes a site's cookies only when the last tab of that site
  closes; closing any other tab is a no-op by design.

## Runtime-confirmed gaps (false negatives)

Each entry below was a real miss, reproduced at runtime, then fixed with a
regression test and a severity decision. They are the birth certificates of
the current catalogue rules.

1. `chrome.storage.local.setAccessLevel` / `chrome.storage.session.setAccessLevel`
   — not implemented in Firefox. Verified: Open Stay Focused's background
   module throws `TypeError` at `background.js:159`
   (`Promise.all([chrome.storage.local.setAccessLevel(...), ...])`). **The crash
   position decides the outcome:** that call sat on the module's last line, so
   every listener was already registered and the add-on survived. In StayFocusd
   4.6.25 the same method throws on **line 2** of the background script, before
   any listener is registered; the message chain is dead and the add-on is
   unusable. Same API, opposite outcome, decided purely by where the throw
   lands. This is the hardest argument for `warning` (not `info`): a fatal call
   cannot be judged benign by the API name alone.
   **Fixed:** `storage.local.setAccessLevel` and `storage.session` are now
   catalogue rules at `warning`, and the report flags the previously missed
   call.

2. Minified namespace aliases hide Chrome-only APIs from static scanning.
   Verified with StayFocusd 4.6.25 (wxt/Webpack build): the shipped
   `background.js` calls `W.storage.session.setAccessLevel(...)`, where `W` is
   a one-letter minified alias of the `chrome` namespace. At runtime Firefox
   throws `TypeError: storage.session.setAccessLevel is not a function` on
   line 2, so no message listener is registered and the popup/content scripts
   emit 260+ `Could not establish connection. Receiving end does not exist.`
   errors — the add-on installs, activates, reports clean, but cannot be used.
   **This case drove the `browser.*` detection expansion:** the scanner matched
   only a literal `chrome.*` root, so every Chrome-only call emitted by a wxt /
   webextension-polyfill / Plasmo build (which use `browser.*`) escaped
   detection. Modern MV3 frameworks make `browser.*` the mainstream form, so
   fixing the detected-root coverage outranked adding any single catalogue
   rule. The scanner now matches catalogue entries under **both** `chrome.*`
   and `browser.*`, sharing one conservative catalogue — supported APIs such
   as `browser.action` / `browser.scripting` are still not flagged.
   A minified alias (`W`) still cannot be tied back to `chrome` without false
   positives on unrelated objects; that remains an inherent static-analysis
   limit on bundled payloads, not a catalogue gap.

3. Firefox does not implement `bookmarks.onChildrenReordered`,
   `bookmarks.onImportBegan`, or `bookmarks.onImportEnded` (MDN compatibility
   data; bug 1319530 open since 2016). Verified with YueVision 1.0.0: its
   background calls `chrome.bookmarks.onChildrenReordered.addListener(...)`
   as a literal `chrome.*` call, and Firefox ESR 153 threw
   `TypeError: can't access property "addListener", chrome.bookmarks
   .onChildrenReordered is undefined` at `background.js:183` while
   `--report` showed **zero findings** — a literal, un-minified call the
   catalogue simply did not cover. Impact stayed contained because the call
   sits on the last line of `init()`: menu creation, background services and
   the four supported bookmark listeners had already run, so only
   reorder-event sync is dead. **Fixed:** the three event names are now
   catalogue rules at `warning` under both roots; supported members of the
   `bookmarks` namespace (`create`, `onCreated`, `onMoved`, `onChanged`, ...)
   remain unflagged.

## Catalogue accuracy observed on this corpus

- True positives: `chrome.sidePanel` (1 hit), `chrome.offscreen` (2 hits),
  `importScripts` (1 hit — matched the exact file and line that failed at
  runtime in Local iTab: `collection-capture-background.js:4`).
- False positives: **0 warnings** across 7 scanned extensions (Alt Text
  Auto-Fill, CookieMop, Cursorfly, Local iTab, Open Stay Focused, Dark Reader,
  Digital Memory). Firefox-supported APIs (`chrome.action`, `chrome.scripting`,
  `chrome.runtime.getManifest`) were never flagged.
- `storage.session` was promoted from `info` to **`warning`** after runtime
  reconciliation: Firefox ESR 153 does **not** expose `browser.storage.session`
  (runtime error `"browser.storage.session" is undefined` in StayFocusd
  content scripts), and the fatal call can abort the whole background module.
  The corpus now proves severity by observed outcome, not by API-name guess.

## Additional extensions verified for install + report accuracy

| Extension | Conversion | Firefox side-load | `--report` |
| --- | --- | --- | --- |
| StayFocusd 4.6.25 | MV3 `service_worker` downgrade; shim + polyfill prepended; shim injected into 2 extension pages | auto id `__msg_extname__@crx2xpi.local`, active, not disabled | 0 findings before the fix — false negative that drove the `browser.*` detection expansion (gaps 1 & 2) |
| Tabliss 2.6.0 | MV3 new-tab-only, no downgrade needed; Gecko id rewrite only | auto id `tabliss-a-beautiful-new-tab@crx2xpi.local`, active, not disabled | 0 findings — accurate; no Chrome-only API used |
| YueVision 1.0.0 | MV3 `service_worker` downgrade; shim + polyfill prepended; shim injected into `popup.html`; auto id `ext-666973@crx2xpi.local` | installed and active, not disabled; background threw on `bookmarks.onChildrenReordered` (gap 3) | 0 findings before the fix — false negative that drove the bookmark-event rules |

Both add-ons were installed with `AddonManager.addInstall` via Marionette in an
isolated profile with `xpinstall.signatures.required=false`. The auto-generated
`@crx2xpi.local` id was accepted by Firefox for both, confirming installability.
