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

## Runtime-confirmed gaps NOT yet in the static catalogue (false negatives)

Do not silently add these as rules; each needs a regression test plus a
decision about severity (`warning` vs `info`).

1. `chrome.storage.local.setAccessLevel` / `chrome.storage.session.setAccessLevel`
   — not implemented in Firefox. Verified: Open Stay Focused's background
   module throws `TypeError` at `background.js:159`
   (`Promise.all([chrome.storage.local.setAccessLevel(...), ...])`). The
   extension survived only because the call sits on the module's last line;
   the same pattern earlier in a module would kill every listener registered
   after it. The static report currently flags that line only for the benign
   `chrome.storage.session` info and misses the fatal call.

## Catalogue accuracy observed on this corpus

- True positives: `chrome.sidePanel` (1 hit), `chrome.offscreen` (2 hits),
  `importScripts` (1 hit — matched the exact file and line that failed at
  runtime in Local iTab: `collection-capture-background.js:4`).
- False positives: **0 warnings** across 7 scanned extensions (Alt Text
  Auto-Fill, CookieMop, Cursorfly, Local iTab, Open Stay Focused, Dark Reader,
  Digital Memory). Firefox-supported APIs (`chrome.action`, `chrome.scripting`,
  `chrome.runtime.getManifest`) were never flagged.
- `chrome.storage.session` produces info-level findings only; it is supported
  in current Firefox, so the conservative severity is appropriate.
