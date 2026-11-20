---
description: webextension-polyfill injection rules — order and priority rationale comments. Apply when working on polyfill injection code.
alwaysApply: false
paths: src/**/*polyfill*.ts,src/core/**/*.ts
---

# webextension-polyfill injection rules

Apply when implementing or reviewing injection of the Mozilla
`webextension-polyfill` (and the `chrome` alias shim) into the converted
add-on.

## Required comments

- Comment the **injection order** and the reason for it: the shim and the
  polyfill must load before any background/content script that calls the
  WebExtension API, otherwise those calls hit `undefined`.
- Comment the **priority** decision: in `background.scripts`, both asset paths
  are prepended (not appended) so they are evaluated first.
- Explain the two-asset order:
  1. `chrome-promise-shim.js` runs first — Firefox keeps `chrome`
     callback-only while Chrome MV3 code calls `await chrome.*`; aliasing
     `chrome` to Firefox's promise-capable `browser` namespace restores
     Chromium semantics.
  2. `browser-polyfill.js` follows — Mozilla's polyfill for code that
     references the promise-based `browser.*` API; a no-op where `browser`
     already exists natively.
- Explain that this exists to bridge Chromium's callback-based `chrome.*` API
  to Firefox's promise-based `browser.*` API.

## Extension pages (popup, options, devtools, ...)

- Extension pages are **separate documents** from the background, so prepending
  the shim to `background.scripts` alone cannot fix them. Firefox exposes the
  callback-only `chrome` namespace in those pages too, and Chrome MV3 popup
  code calling `await chrome.*` silently stalls the page (visible symptom: the
  popup hangs on its loading screen with no console error).
- When a service_worker downgrade is applied, every payload `.html` page that
  contains a `<script` element gets `<script src="chrome-promise-shim.js">`
  inserted immediately after its opening `<head>` tag (or prepended when no
  `<head>` exists), so the alias is installed before any other script runs.
- The reference URL must be **relative to each page's own directory** (e.g.
  `../../chrome-promise-shim.js` for `ui/popup/index.html`); a wrong path
  404s inside the package and silently disables the alias again.
- The shim only — not the polyfill — is injected into pages: `browser` already
  exists natively in Firefox extension pages, so the polyfill would be a
  redundant download there.
- Page injection is gated on the same condition as the background injection
  (MV3 downgrade present): MV2 popups keep callback-style `chrome` calls that
  Firefox supports natively.

## Design constraints

- Never inject an asset twice; check for an existing entry first.
- Preserve the original script order after the injected entries.
- Injection is a single-purpose, testable function with full TSDoc
  (`@param`, `@returns`, `@throws`).
- If the injection + validation logic exceeds 50 lines, split it.
