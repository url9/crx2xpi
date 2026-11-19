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

## Design constraints

- Never inject an asset twice; check for an existing entry first.
- Preserve the original script order after the injected entries.
- Injection is a single-purpose, testable function with full TSDoc
  (`@param`, `@returns`, `@throws`).
- If the injection + validation logic exceeds 50 lines, split it.
