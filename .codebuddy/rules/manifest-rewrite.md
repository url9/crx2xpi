---
description: Manifest rewrite rules — service_worker downgrade rationale comments. Apply when working on manifest transformation code.
alwaysApply: false
paths: src/manifest/**/*.ts
---

# Manifest rewrite rules

Apply when implementing or reviewing `manifest.json` transformations.

## service_worker downgrade — required comment

The rewrite that converts `service_worker` to `background.scripts` must include
a comment explaining **why**:

> Firefox / GeckoView does not implement Chromium's MV3 service workers; Gecko
> still expects the MV2-style event page declared via `background.scripts`.
> Without the rewrite the XPI would lose all background behaviour.

Do not reduce this to "convert service_worker to scripts". The rationale is the
point.

## Design constraints

- The downgrade must be idempotent: never duplicate a worker already present in
  `background.scripts`.
- Preserve existing `background` fields; merge, do not overwrite.
- Leave MV2 manifests and MV3 manifests without a `service_worker` untouched.
- Each rewrite rule is a small, single-purpose function with full TSDoc.
- A rewrite function over 50 lines must be split, with a header comment listing
  the rewrite steps.
