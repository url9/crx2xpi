---
description: Testing and CI rules for crx2xpi — Vitest, coverage, required local checks. Apply to test files and CI workflow edits.
alwaysApply: false
paths: tests/**/*.ts,.github/workflows/**/*.yml
---

# Testing and CI rules

## Test framework

- Vitest runs in the `node` environment; tests live in `tests/**/*.test.ts`.
- Unit-test each rewrite/parse rule in isolation with fresh fixtures.
- Cover the happy path, idempotency, and no-op cases (e.g. MV2 left untouched).

## Real-sample fixture naming (mandatory)

- Every extension binary checked into the repository (fixtures, samples) MUST
  be named `<extension-name> (<developer>).<ext>`: the base name, ONE space,
  then the developer/publisher name inside ASCII half-width parentheses.
- Example: `sample-mv3 (crx2xpi).crx`.
- For synthetic samples produced by this project, use `crx2xpi` as the
  developer name. The rule covers both `.crx` inputs and `.xpi` artifacts.
- Only self-generated samples may be checked in. Never vendor third-party
  extension binaries: redistributing them here is not license-compliant.
- Integration tests reference fixtures by this exact name so a rename without
  updating tests fails loudly.

## Required local checks before finishing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

All four must pass. Do not declare a task complete with failing checks.

## CI

- `.github/workflows/ci.yml` runs on push and PR to `main`.
- Jobs: lint, strict typecheck, format check, unit tests, build.
- Uses pnpm with a frozen lockfile and Node 20.
- Never weaken CI to make a failing build pass; fix the root cause.

## Test code style

- Test helper functions also carry TSDoc if exported; local helpers are fine
  without, but keep them small and clearly named.
- Prefer `toEqual` for object/array assertions and explicit `toBeUndefined()`
  for removed fields.
