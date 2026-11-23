---
description: Manifest rewrite rules — safe Chrome-to-Gecko manifest transformations and the rewrites we deliberately avoid.
alwaysApply: false
paths: src/core/manifest-rewrite.ts, src/core/converter.ts, src/parsers/manifest-parser.ts
---

# Manifest rewrite rules

Apply when implementing or reviewing `manifest.json` transformations. The
engine owns two things: the `service_worker` downgrade (in `manifest-parser.ts`
+ `converter.ts`) and the broader Gecko rewrite set (in `manifest-rewrite.ts`).

## service_worker downgrade — required comment

The rewrite that converts `service_worker` to `background.scripts` must include
a comment explaining **why**:

> Firefox / GeckoView does not implement Chromium's MV3 service workers; Gecko
> still expects the MV2-style event page declared via `background.scripts`.
> Without the rewrite the XPI would lose all background behaviour.

Do not reduce this to "convert service_worker to scripts". The rationale is the
point.

## Safe rewrite set

`rewriteManifestForGecko` applies these idempotent rules to EVERY converted
manifest (MV2 and MV3):

- Inject a stable `browser_specific_settings.gecko.id`: SHA-256 of the display
  name (first 12 hex chars, empty name falls back to `unknown-extension`) as
  `<hash>@crx2xpi.local`. Deterministic across re-conversions; a caller-supplied
  validated id (`options.customGeckoId`) is used when the manifest has none.
  Never overwrite an existing id.
- Remove Chrome-only keys: `key`, `update_url`, `minimum_chrome_version`,
  `oauth2`, `export`.
- Rename an MV3 `browser_action` to `action` without clobbering an existing
  `action`.
- Move host match patterns from `permissions` into `host_permissions` (MV3
  only); merge with existing hosts and de-duplicate without dropping any.
- Strip `use_dynamic_url` from MV3 `web_accessible_resources`. Do NOT fabricate
  a `<all_urls>` match — widening site access is a security decision for the
  developer.
- Normalise a string `content_security_policy` to the MV3 object form
  (`{ extension_pages }`). Do NOT add `'wasm-unsafe-eval'`.

## Rewrites we deliberately do NOT copy

Other converters apply these; each introduces a real bug or a security
regression, so they are forbidden here:

- Force `content_scripts[].all_frames = true` — injects into every iframe and
  changes page behaviour.
- Add `'wasm-unsafe-eval'` to CSP unconditionally — needlessly widens policy.
- Drop `background.type` — module workers need it to parse static `import`.
- Inject a fixed bundle of runtime shims into every add-on — unconditional
  shims can shadow native Firefox APIs (e.g. assigning to the read-only
  `browser.scripting` namespace). Only the verified chrome-alias shim +
  Mozilla polyfill are injected, and only for MV3 downgrades.

## Design constraints

- The downgrade must be idempotent: never duplicate a worker already present in
  `background.scripts`.
- Preserve existing `background` fields (including MV2 `persistent`); merge, do
  not overwrite.
- Version-specific rules gate themselves on `manifest_version`; MV2 keeps its
  `persistent` flag and its `browser_action`.
- Each rewrite rule is a small, single-purpose pure function returning a NEW
  object, with full TSDoc.
- A rewrite function over 50 lines must be split, with a header comment listing
  the rewrite steps.

## Diagnostics are report-only

Compatibility analysis (`diagnostics.ts`) must never rewrite source or inject
shims. It reports Chrome-only API usage and `importScripts()` calls with file +
line and a suggested action, and states that static analysis cannot prove
runtime correctness. This keeps the risky remediation decision with the human
reviewer.
