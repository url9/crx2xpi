# crx2xpi

English | [中文](README.zh.md)

> Convert Chrome MV3 extensions (CRX3) into Firefox / GeckoView-compatible XPI add-ons.

`crx2xpi` aims to become an industrial-grade, community-maintained bridge
between the Chromium WebExtension runtime and Gecko. It strips the CRX3 signing
header, rewrites MV3-specific manifest fields (notably the `service_worker`
downgrade), and injects the `webextension-polyfill` before packaging a signed-ready
XPI.

> **Status:** the conversion engine and CLI are working end to end. CRX3
> unpacking, the MV3 `service_worker` downgrade, polyfill injection, and XPI
> repacking are implemented and covered by unit, integration (real CRX3
> sample), and CLI tests. See [CONTRIBUTING.md](./CONTRIBUTING.md) to help
> improve it.

## CLI usage

Install globally, run with `npx`, or use it directly from a checkout:

```bash
# After installing from npm (once published) or via a global install
npx crx2xpi my-extension.crx my-extension.xpi

# Verbose mode prints every conversion stage
npx crx2xpi --verbose my-extension.crx my-extension.xpi

# Keep the extracted payload directory on disk for debugging
npx crx2xpi --keep-temp my-extension.crx my-extension.xpi
```

From a repository checkout, run the built binary directly:

```bash
pnpm build
node dist/cli.js --verbose sample.crx out/sample.xpi
```

Options:

| Option | Short | Description |
| --- | --- | --- |
| `<input.crx>` | — | Source Chrome CRX3 extension file. |
| `<output.xpi>` | — | Destination Firefox XPI add-on file (parent directories are created). |
| `--verbose` | `-v` | Print detailed progress: header validation, manifest parsing, polyfill injection, repacking. |
| `--keep-temp` | `-k` | Keep the extracted payload directory for debugging; its path is printed on success. |

Example session with `--verbose`:

![crx2xpi CLI converting a CRX3 sample in a terminal](./docs/cli-screenshot.png)

The CLI exits with code `0` on success and `1` on usage or conversion errors.
Bundled polyfill: the packaged XPI ships Mozilla's official
[`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill)
(MPL-2.0, see [NOTICE](./NOTICE)); the injected entry is always evaluated
first in `background.scripts`.

## How to install the generated XPI (Installation)

> Under Mozilla's official security policy, extensions that are not signed by
> its servers cannot be installed in release versions of Firefox. Choose the
> method that fits your scenario below:
>
> **Prerequisite**: except for `about:debugging` temporary loading, every
> installation method (Android install-from-file, AMO signing) requires an
> extension ID in the XPI's `manifest.json`
> (`browser_specific_settings.gecko.id`). If the source extension does not
> declare one, add it manually to the converted manifest (for example
> `"id": "@your-extension-id"`).

### Scenario 1: Desktop testing (Firefox Developer Edition / Nightly / ESR)

The signature-enforcement override only works in those three channels.
Release and Beta remove the preference at build time, so toggling it has no
effect.

1. Open Firefox, type `about:config` in the address bar, press Enter, and
   accept the risk notice.
2. Search for `xpinstall.signatures.required` and double-click to set its value
   to `false`.
3. Type `about:debugging` in the address bar.
4. Click **This Firefox** on the left, then **Load Temporary Add-on...**, and
   select your converted `.xpi` file (or an extracted `manifest.json`).
   Temporarily loaded add-ons are removed when Firefox restarts.

### Scenario 2: Mobile testing (Firefox for Android, all channels)

Firefox for Android has no `about:config`, so the desktop signing-override path
does not exist; a hidden menu takes its place. Since Firefox 122 (January 2024)
this works in the release channel too (requires Android 10 or later):

1. Open Firefox and go to **Settings** → **About Firefox**.
2. Tap the Firefox logo five times in quick succession to unlock the hidden
   menu.
3. Go back to Settings; a new **Install Extension from File** entry now
   appears.
4. Select the `.xpi` file you saved locally to install it.

### Scenario 3: Permanent installation (desktop and mobile)

AMO signing is the only official path for installation in Release and Beta.
Two channels are available when submitting:

- **unlisted** (self-distributed, not published on AMO): automated review only,
  usually signed within seconds to minutes — ideal for private distribution
  and the choice for most testing scenarios.
- **listed** (publicly published): requires human review before appearing
  publicly, intended for production releases.

Steps:

1. Visit the [Mozilla Add-ons (AMO)](https://addons.mozilla.org/developers/)
   developer center and sign in.
2. Choose **Submit a New Add-on** and upload your converted `.xpi` file
   (select the unlisted option for private distribution).
3. Mozilla signs the submission (unlisted is usually fast; automated review
   can take up to 24 hours, and some submissions are escalated to manual
   review).
4. Download the signed `.xpi`; it can now be installed directly in any
   official release version of Firefox.

### Installation channel quick reference

| Method | Desktop Release | Desktop Beta | Desktop Dev / Nightly / ESR | Android (all channels) | GeckoView-hosted browsers |
| --- | :-: | :-: | :-: | :-: | :-: |
| AMO signing (listed / unlisted) | ✅ | ✅ | ✅ | ✅ | Not needed |
| Disable signing `xpinstall.signatures.required=false` | ❌ ignored | ❌ ignored | ✅ | ❌ no `about:config` | ❌ not enforced |
| `about:debugging` temporary load | ❌ | ❌ | ✅ | ❌ | Host-dependent |
| 5-tap "Install Extension from File" | — | — | — | ✅ (Firefox 122+, Android 10+) | Host-dependent |
| Host loads the XPI file directly | ❌ | ❌ | ❌ | ❌ | ✅ |

Rule of thumb: **on desktop, check the channel (the override only exists in
Dev / Nightly / ESR); on mobile, count the taps (there is no config editor);
in an embedded engine, check the host** — signature enforcement is a Firefox
distribution policy, not a Gecko engine policy. Third-party browser shells
built on GeckoView are not bound by Mozilla's signing requirement and can load
converted packages directly.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Prerequisites

- Node.js **>= 20**
- pnpm **>= 9** (`corepack enable && corepack prepare pnpm@9 --activate`)

## Getting started

```bash
pnpm install
pnpm test          # unit tests (Vitest)
pnpm lint          # ESLint static analysis
pnpm typecheck     # TypeScript strict check
pnpm format:check  # Prettier formatting check
pnpm build         # compile to dist/
```

## Commit convention (Conventional Commits)

Every commit is validated by `commitlint` through a Husky `commit-msg` hook.
Allowed prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
`build:`, `ci:`, `perf:`, `style:`, `revert:`.

```text
feat: implement CRX3 header parsing
fix: preserve background scripts when service_worker is absent
docs: document the manifest rewrite pipeline
```

You may write messages by hand or use the interactive Commitizen prompt, which
walks you through selecting the type, scope, and subject:

```bash
pnpm commit       # alias for `cz`
```

Commitizen is configured in `package.json` under `config.commitizen` with the
`cz-conventional-changelog` adapter, so the generated messages automatically
satisfy commitlint.

The repository's original `Initial commit` is preserved as-is; all subsequent
commits follow the convention above.

## Project rules

Engineering, documentation, and review rules for AI assistants and contributors
live in [`.codebuddy/rules`](./.codebuddy/rules) and
[`.codebuddy/CODEBUDDY.md`](./.codebuddy/CODEBUDDY.md). These rules cover JSDoc
requirements, comment philosophy, the CRX3 magic-byte layout, the
`service_worker` downgrade rationale, and polyfill injection order.

## Code of Conduct

Participation is governed by the [Contributor Covenant](./CODE_OF_CONDUCT.md).
