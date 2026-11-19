# crx2xpi — Project Memory

crx2xpi converts Chrome MV3 extensions (CRX3) into Firefox / GeckoView XPI
add-ons. This file is the root project instruction loaded into every session.
Detailed, scoped rules live in [`rules/`](./rules/) and are auto-discovered
recursively.

## Non-negotiable invariants

1. **Never modify the original `Initial commit` (`b40787d`).** It is the
   historical root of the remote repository. All new work adds commits on top.
2. **Every commit message must be Conventional Commits** and pass commitlint:
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, `ci:`,
   `perf:`, `style:`, `revert:`. No exceptions.
3. **Strict TypeScript.** `strict: true`; never introduce `any`. Use `unknown`
   plus narrowing, or a precise interface/type.
4. **Complete TSDoc on every exported function, interface, class and type**
   (`@param`, `@returns`, `@throws` where applicable).
5. **Comments explain WHY, not WHAT.** Meaningless narration such as
   `i++ // increment i` is forbidden.
6. **Single responsibility.** A parsing function over 50 lines must be split,
   with a header comment describing the parsing steps.
7. **No conversion engine code yet.** This phase is scaffolding only; do not
   implement CRX3→XPI conversion logic beyond the tested manifest-parser unit.

## Required commands before declaring work done

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

CI runs all of the above plus `pnpm build` on every push and PR to `main`.

## Rule index

- `rules/engineering-standards.md` — always applied: commits, TS strictness,
  function size, forbidden patterns.
- `rules/jsdoc-and-comments.md` — always applied: documentation and comment style.
- `rules/crx3-parsing.md` — CRX3 header/magic-byte comment requirements.
- `rules/manifest-rewrite.md` — service_worker downgrade rationale comments.
- `rules/polyfill-injection.md` — polyfill injection order comments.
- `rules/testing-and-ci.md` — tests and CI expectations.

When writing or reviewing code, consult the scoped rule that matches the files
you are touching.
