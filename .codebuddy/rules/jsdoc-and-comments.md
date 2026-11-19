---
description: JSDoc/TSDoc and comment-style requirements for crx2xpi source code. Applies to all TypeScript files.
alwaysApply: true
---

# JSDoc / TSDoc and comment style (always applied)

## Mandatory TSDoc on exported symbols

Every **exported** function, interface, class, type alias, and enum must carry a
complete JSDoc/TSDoc block:

- One-line summary describing intent, not mechanics.
- `@param name` for every parameter, with a short description.
- `@returns` describing the value (and its meaning), including `void` semantics
  if non-obvious.
- `@throws` for every error the function can deliberately raise.

Example:

```ts
/**
 * Downgrade an MV3 service_worker into background.scripts for Gecko.
 *
 * @param manifest - Parsed manifest object, mutated in place.
 * @returns The same manifest with the downgrade applied when relevant.
 * @throws {TypeError} When the manifest is not an object.
 */
export function downgradeServiceWorker(manifest: WebExtensionManifest): WebExtensionManifest {}
```

## Comments explain WHY

- A comment must justify a non-obvious decision, a constraint, or a workaround.
- Never restate the code: `i++ // increment i` is forbidden.
- Good: `// Firefox ignores MV3 service workers; use MV2-style scripts instead.`
- Document magic numbers and byte offsets at the point they are used.

## Multi-step parsing functions

- Put a header comment enumerating the steps before the body.
- Keep each step as a short, individually named helper where practical.

## Keeping docs in sync

- Changing a function's signature requires updating its TSDoc in the same commit.
- ESLint (`jsdoc/require-*`) enforces presence; reviewers enforce quality.
