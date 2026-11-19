# Contributing to crx2xpi

Thanks for your interest in improving `crx2xpi`. This project aims to be an
industrial-grade, community-maintained bridge between Chromium MV3 extensions
and the Gecko/WebExtension runtime. Every contribution — bug report, fix,
documentation, or feature — is welcome.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
Please read it before opening an issue or pull request.

## Getting started

Prerequisites:

- Node.js **>= 20** (LTS recommended)
- pnpm **>= 9** (`corepack enable && corepack prepare pnpm@latest --activate`)

```bash
git clone https://github.com/ckb66/crx2xpi.git
cd crx2xpi
pnpm install
```

## Development workflow

```bash
pnpm lint          # ESLint static analysis
pnpm format:check  # Prettier formatting check
pnpm typecheck     # TypeScript strict type check (no emit)
pnpm test          # Vitest unit tests (single run)
pnpm test:watch    # Vitest in watch mode
```

Before submitting, make sure all four checks pass locally — CI runs the exact
same commands.

## Branching

- Create a topic branch from `main`: `git checkout -b feat/my-change`.
- Keep branches focused on a single concern; one PR per logical change.

## Commit convention (mandatory)

We follow [Conventional Commits](https://www.conventionalcommits.org/). Every
commit message **must** use one of the allowed type prefixes:

| Prefix       | When to use                                   |
| ------------ | --------------------------------------------- |
| `feat:`      | A new feature                                  |
| `fix:`       | A bug fix                                      |
| `docs:`      | Documentation only                             |
| `refactor:`  | Code change that neither fixes nor adds        |
| `test:`      | Adding or correcting tests                     |
| `chore:`     | Tooling, dependencies, housekeeping            |
| `build:`     | Build system or output changes                  |
| `ci:`        | CI configuration changes                        |
| `perf:`      | Performance improvements                        |
| `style:`     | Formatting / white-space only                   |
| `revert:`    | Reverts a previous commit                       |

Examples:

```
feat: implement CRX3 header parsing
fix: preserve background scripts when no service_worker exists
docs: document the manifest rewrite pipeline
refactor: split parseManifest into focused helpers
test: cover service_worker downgrade edge cases
```

A breaking change is indicated with `!` after the type or a `BREAKING CHANGE:`
footer. Commit messages are enforced by `commitlint` via a Husky `commit-msg`
hook, so a malformed message will be rejected locally. You may also run
`pnpm commit` to use Commitizen's interactive prompt.

## Code style

- TypeScript `strict` mode is mandatory; **do not abuse `any`**. Prefer `unknown`
  plus narrowing, or a precise interface/type. `@typescript-eslint/no-explicit-any`
  is an error.
- Formatting is handled by Prettier (2-space indent, single quotes, trailing
  commas, LF line endings). Run `pnpm format` before committing.
- Cross-platform consistency is enforced by `.editorconfig`.
- **JSDoc/TSDoc is required on every exported function, interface, class and
  type**, including `@param`, `@returns` and `@throws` where applicable.
- Comments must explain *why*, never restate *what*. See the rules in
  [`.codebuddy/rules`](./.codebuddy/rules) for project-specific documentation
  requirements (CRX3 magic bytes, service_worker downgrade rationale,
  polyfill injection order).
- Keep functions small and single-purpose. A parsing function longer than
  **50 lines** must be split, with a header comment describing the steps.

## Pull requests

1. Fork the repository and create your topic branch.
2. Add or update tests for your change.
3. Ensure `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` pass.
4. Open a PR against `main` with a clear description of the problem and solution.
5. Link any related issue (e.g. `Closes #42`).

CI must be green before a PR can be merged. Maintainers may request changes.

## Reporting bugs

Use the [bug report template](./.github/ISSUE_TEMPLATE/bug_report.md) and include
a minimal CRX sample (or instructions to reproduce) plus your Node.js / pnpm
versions.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
