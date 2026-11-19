# crx2xpi

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

## 如何安装生成的 XPI

> 由于 Mozilla 官方的安全策略，未经其服务器签名的扩展无法直接安装在 Firefox 正式版中。请根据您的使用场景选择以下方式：
>
> **前提提醒**：除 `about:debugging` 临时载入外，其余安装方式（Android 从文件安装、AMO 签名）都要求 XPI 的 `manifest.json` 中包含扩展 ID（`browser_specific_settings.gecko.id`）。若源扩展未声明该字段，请在转换后的 manifest 中手动补一个（如 `"id": "@your-extension-id"`）。

### 场景一：桌面端测试（Firefox Developer Edition / Nightly / ESR）

签名豁免开关只在上述三个渠道生效；正式版（Release）与 Beta 在构建层面移除了该开关，设置会被直接忽略。

1. 打开 Firefox，在地址栏输入 `about:config` 并回车，接受风险提示后继续。
2. 搜索 `xpinstall.signatures.required`，将其值双击改为 `false`。
3. 在地址栏输入 `about:debugging`。
4. 点击左侧的「此 Firefox」，点击「临时载入附加组件...」，选择你转换出来的 `.xpi` 文件（或解压后的 `manifest.json`）。临时载入的扩展在 Firefox 重启后失效。

### 场景二：移动端测试（Firefox for Android 正式版）

Android 版没有 `about:config`，无法走桌面那条关签名路径，取而代之的是一个隐藏菜单。自 Firefox 122（2024 年 1 月）起，该方式在正式版即可使用（需 Android 10 及以上）：

1. 打开 Firefox，进入「设置」→「关于 Firefox」。
2. 在 Firefox 图标上快速连续点击 5 次，解锁隐藏菜单。
3. 返回设置页面，此时会出现新的「从文件安装扩展」入口。
4. 选择你保存到本地的 `.xpi` 文件进行安装。

### 场景三：永久安装（桌面 / 移动通用）

AMO 签名是正式版与 Beta 上安装的唯一官方途径。提交时可选两种渠道：

- **unlisted（自分发，不上架）**：仅走自动化审核，通常数秒到数分钟完成签名，适合私有分发——绝大多数测试场景选这个。
- **listed（公开上架）**：需要人工审核后才会公开显示，适合正式发布。

步骤：

1. 访问 [Mozilla Add-ons (AMO)](https://addons.mozilla.org/developers/) 开发者中心并登录。
2. 选择「提交新附加组件」，上传你转换出来的 `.xpi` 文件（unlisted 请选择对应选项）。
3. 提交后由 Mozilla 进行签名（unlisted 通常很快；自动化审核最长可能需要 24 小时，个别情况会转人工审核）。
4. 下载签名完成后的 `.xpi`，此时可以在任何官方正式版 Firefox 中直接安装。

### 渠道支持速查

| 安装方式 | 桌面 Release | 桌面 Beta | 桌面 Dev / Nightly / ESR | Android 全渠道 | GeckoView 宿主浏览器 |
| --- | :-: | :-: | :-: | :-: | :-: |
| AMO 签名（listed / unlisted） | ✅ | ✅ | ✅ | ✅ | 无需 |
| 关签名 `xpinstall.signatures.required=false` | ❌ 开关被忽略 | ❌ 开关被忽略 | ✅ | ❌ 无 `about:config` | ❌ 不强制签名 |
| `about:debugging` 临时载入 | ❌ | ❌ | ✅ | ❌ | 取决于宿主 |
| 5 连点「从文件安装扩展」 | — | — | — | ✅（Firefox 122+，Android 10+） | 取决于宿主 |
| 宿主直接加载 XPI 文件 | ❌ | ❌ | ❌ | ❌ | ✅ |

记忆口诀：**桌面看渠道（豁免只认 Dev / Nightly / ESR）、移动看连点（没有 config 编辑器）、内嵌看宿主（签名强制是 Firefox 发行版策略，不是 Gecko 引擎策略）**。基于 GeckoView 的第三方浏览器壳不受 Mozilla 签名强制约束，可直接加载转换产物。

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
