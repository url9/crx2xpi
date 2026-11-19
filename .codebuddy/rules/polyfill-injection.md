---
description: webextension-polyfill injection rules — order and priority rationale comments. Apply when working on polyfill injection code.
alwaysApply: false
paths: src/**/*polyfill*.ts
---

# webextension-polyfill injection rules

Apply when implementing or reviewing injection of the Mozilla
`webextension-polyfill` into the converted add-on.

## Required comments

- Comment the **injection order** and the reason for it: the polyfill must load
  before any background/content script that calls the promise-based `browser.*`
  API, otherwise those calls hit `undefined`.
- Comment the **priority** decision: in `background.scripts`, the polyfill path
  is prepended (not appended) so it is evaluated first.
- Explain that this exists to bridge Chromium's callback-based `chrome.*` API to
  Firefox's promise-based `browser.*` API.

## Design constraints

- Never inject the polyfill twice; check for an existing entry first.
- Preserve the original script order after the polyfill entry.
- Injection is a single-purpose, testable function with full TSDoc
  (`@param`, `@returns`, `@throws`).
- If the injection + validation logic exceeds 50 lines, split it.
