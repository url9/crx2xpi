# 为 crx2xpi 做贡献

[English](CONTRIBUTING.md) | 中文

感谢你有兴趣改进 `crx2xpi`。本项目致力于成为 Chromium MV3 扩展与 Gecko/WebExtension 运行时之间的工业级、社区维护的桥梁。欢迎任何贡献——错误报告、修复、文档或新功能。

## 行为准则

参与本项目即表示同意遵守[行为准则](./CODE_OF_CONDUCT.md)。在提交 issue 或 pull request 前请先阅读它。

## 快速开始

前置要求：

- Node.js **>= 20**（推荐 LTS）
- pnpm **>= 9**（`corepack enable && corepack prepare pnpm@latest --activate`）

```bash
git clone https://github.com/url9/crx2xpi.git
cd crx2xpi
pnpm install
```

## 开发流程

```bash
pnpm lint          # ESLint 静态检查
pnpm format:check  # Prettier 格式检查
pnpm typecheck     # TypeScript 严格类型检查（不产出文件）
pnpm test          # Vitest 单元测试（单次运行）
pnpm test:watch    # Vitest 监听模式
```

提交前请确保以上四项检查在本地全部通过——CI 运行的正是同样的命令。

## 分支管理

- 从 `main` 创建主题分支：`git checkout -b feat/my-change`。
- 让分支专注于单一问题；一个逻辑变更对应一个 PR。

## 提交规范（强制）

我们遵循 [Conventional Commits](https://www.conventionalcommits.org/)。每笔提交信息**必须**使用以下允许的类型前缀之一：

| 前缀 | 使用场景 |
| --- | --- |
| `feat:` | 新功能 |
| `fix:` | 错误修复 |
| `docs:` | 仅文档变更 |
| `refactor:` | 既不修复也不新增功能的代码变更 |
| `test:` | 添加或修正测试 |
| `chore:` | 工具、依赖、日常维护 |
| `build:` | 构建系统或产物变更 |
| `ci:` | CI 配置变更 |
| `perf:` | 性能优化 |
| `style:` | 仅格式 / 空白变更 |
| `revert:` | 撤销之前的提交 |

示例：

```
feat: implement CRX3 header parsing
fix: preserve background scripts when no service_worker exists
docs: document the manifest rewrite pipeline
refactor: split parseManifest into focused helpers
test: cover service_worker downgrade edge cases
```

破坏性变更在类型后加 `!`，或在页脚写 `BREAKING CHANGE:`。提交信息由 Husky 的 `commit-msg` 钩子通过 `commitlint` 强制校验，格式错误的信息会在本地被拒绝。你也可以运行 `pnpm commit` 使用 Commitizen 的交互式提示。

## 项目规则

面向 AI 助手和贡献者的工程、文档与审查规则位于 [`.codebuddy/CODEBUDDY.md`](./.codebuddy/CODEBUDDY.md) 和 [`.codebuddy/rules`](./.codebuddy/rules)，涵盖 JSDoc 要求、注释哲学、CRX3 魔数字节布局、`service_worker` 降级原理和 polyfill 注入顺序。

仓库最初的 `Initial commit` 不可改动：禁止 amend、rebase、squash 或 reset 掉它，所有新工作都在其上追加提交。

## 代码风格

- 必须使用 TypeScript `strict` 模式；**不要滥用 `any`**。优先使用 `unknown` 加类型收窄，或精确的接口/类型。`@typescript-eslint/no-explicit-any` 是错误级别。
- 格式化由 Prettier 处理（2 空格缩进、单引号、尾随逗号、LF 换行）。提交前运行 `pnpm format`。
- 跨平台一致性由 `.editorconfig` 保证。
- **每个导出的函数、接口、类和类型都必须有 JSDoc/TSDoc**，在适用处包含 `@param`、`@returns` 和 `@throws`。
- 注释必须解释*为什么*，绝不能复述*做了什么*。项目特定的文档要求见 [`.codebuddy/rules`](./.codebuddy/rules)（CRX3 魔数字节、`service_worker` 降级原理、polyfill 注入顺序）。
- 保持函数短小且单一职责。超过 **50 行**的解析函数必须拆分，并写头部注释说明各步骤。

## Pull request

1. Fork 仓库并创建主题分支。
2. 为你的变更添加或更新测试。
3. 确保 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm format:check` 通过。
4. 向 `main` 提交 PR，清楚描述问题与解决方案。
5. 关联相关 issue（例如 `Closes #42`）。

PR 合并前 CI 必须为绿。维护者可能要求修改。

## 报告错误

使用[错误报告模板](./.github/ISSUE_TEMPLATE/bug_report.md)，并附上最小的 CRX 样本（或复现步骤）以及你的 Node.js / pnpm 版本。

## 许可证

贡献即表示你同意你的贡献以 [Apache License 2.0](./LICENSE) 授权。
