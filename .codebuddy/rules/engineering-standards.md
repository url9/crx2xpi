---
description: Core engineering standards for crx2xpi — commits, strict typing, function size, forbidden patterns. Applies to every session.
alwaysApply: true
---

# Engineering standards (always applied)

## Git / commits

- Messages follow **Conventional Commits** and must pass commitlint. Allowed
  types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`,
  `perf`, `style`, `revert`.
- The original `Initial commit` (`b40787d`) is immutable — never amend, rebase,
  squash, or reset it away.
- Scope example: `feat(manifest): downgrade service_worker for Gecko`.

## TypeScript strictness

- `tsconfig.json` sets `strict: true`, `noImplicitAny`, `noUnusedLocals`,
  `noUnusedParameters`, `exactOptionalPropertyTypes`.
- **Never use `any`.** If the type is genuinely unknown, use `unknown` and
  narrow it. `@typescript-eslint/no-explicit-any` is an error.
- Prefer `interface` for object shapes that may be extended, `type` for unions
  and intersections.
- Use `import type` for type-only imports (enforced by ESLint).

## Function design

- One function, one responsibility.
- A parsing/rewrite function **longer than 50 lines must be split** into helpers.
- When a function implements a multi-step parse, put a header comment listing
  the steps in order, then keep each step visually separated.

## Formatting

- Prettier: 2-space indent, single quotes, trailing commas, LF endings, 100-col.
- `.editorconfig` guarantees cross-platform consistency — do not fight it.
- Run `pnpm format:check` and `pnpm lint` before finishing any change.

## Forbidden

- `any` abuse, `@ts-ignore`, unchecked non-null assertions used to silence errors.
- Meaningless comments (`i++ // increment i`).
- Committing generated artifacts (`dist/`, `node_modules/`, `*.xpi`, `*.crx`).
  Exception: real CRX3 samples under `tests/fixtures/` are checked-in test
  fixtures and must be committed.
- Hard-coding secrets or tokens in any tracked file.
