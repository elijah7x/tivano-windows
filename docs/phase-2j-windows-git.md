# 阶段 2j — Windows 只读 Git 与 helper `--run` 通道

基线：`465959f42bf26b852e8d8a8dba0cde2cd1a7ff35`（维护者本地验收：663 单测 / 107 桌面检查）。
本阶段在 2f 只读 Git 后端之上接通 Windows 侧执行链，并把 Job helper 升级到 1.2.0（新增 `--run` 退出码通道；`--serve` 语义逐字保留）。

## 改动面

| 文件 | 内容 |
|---|---|
| `helpers/win32/tivano-job-helper.cpp` | `--run` 模式：自然退出 0..255 → helper 退出 `1024+code`；>255 或无法证明 → 类 6；helper/setup/cleanup/forced 类仍 2..6；`--version` 升 1.2.0 并输出 `runExitBase`/`runExitMax` |
| `src/main/gitRuntimeConfig.ts`（新） | win32 git.exe 解析：`TIVANO_GIT_EXECUTABLE` 必须绝对、安全、存在，失效即 `git-config-invalid` **不回退**；其次标准 Git for Windows 安装位置、`PATH` 中绝对项；皆无 → `no-git`。`gitChildEnv` 平台化（Windows PATH 仅 Git 目录+系统目录） |
| `src/main/gitExec.ts` | `GitRunResult.executorFailed` 与 Git 退出码严格区分；`makeGitRunnerViaJobHelper()`：spec 编码、`--run` 解码 1024..1279、helper 类 2..6 → `executor-*`、EOF 取消→有界升级、清理未证实 **sticky 拒用** |
| `src/main/gitView.ts` | probe 平台化：`\r\n` 输出、win32 worktree 物理比较、`GIT_CEILING_DIRECTORIES` 用 `;` 分隔 |
| `src/main/gitService.ts` | `unavailableReason`/`executorFailed` 原因透传、dispose 等待已观测子进程 |
| `src/main/index.ts` | 无条件共享 probe；win32 下 Git 接线要求 helper `runCapable`，无 git.exe → `no-git` 诚实态 |
| `src/main/providerProcessLifecycle.ts` | `JobHelperMode` 参数 + `runCapable` 能力字段；`JOB_HELPER_RUN_EXIT_BASE/MAX` 唯一定义处 |
| `src/main/packagedJobHelper.ts` | 版本 JSON 解析 `runExitBase`/`runExitMax`，attestation 要求精确匹配 |
| `src/renderer/components/GitPanel.tsx` + `i18n.ts` | 机器原因 → 用户文案：`no-git`/`git-config-invalid`/`executor-*`/`unsupported-*` 诚实呈现，不泄露实现细节 |
| `scripts/lib/smoke-flow.mjs` | Windows smoke requires the actual non-repository fixture result or no-git, with matching UI |
| `scripts/package-windows.mjs` | `--version` 契约校验增加 `runExitBase`/`runExitMax` |
| `tests/windows/helper-harness.mjs` | `--run` 用例：自然退出、非零、255 上限、越界 fail-closed、helper 类、stdio 字节保真（**Windows NOT RUN**） |
| `scripts/windows/packaged-git-test.mjs`（新） | 打包态真实 git.exe 验收入口（**Windows NOT RUN**） |

## `--run` 契约

```
helper exit = 1024 + payloadExit   当且仅当自然退出且 code ∈ 0..255 且 Job 已证空、stdio 已排空
helper exit ∈ 2..6                 helper/设置/清理/CreateProcess/forced 类（与 --serve 相同语义）
payloadExit > 255                  → 诊断 + 类 6（永不进 1024..1279 窗口）
```

`--serve` 不变：payload 0 → 0；非零/forced → 6 + 诊断。两模式共享 spec 解析、owner 校验、Job 启动、监控、有界清理与 stdio，仅最终退出映射分支不同。

## 验证（本机 darwin/arm64）

- `tests/gitJobRunner.test.ts` 19/19、`tests/gitRuntimeConfig.test.ts` 26/26（新）
- 聚焦五文件：`gitSlice`+`gitExec`+`gitJobRunner`+`gitRuntimeConfig`+`packagedJobHelper` = 128/128
- `npm run verify`：build + tsc 0 错 + 全部单测 + 107/107 e2e（见 progress.json 实数）

## 明确 NOT RUN（不得以本机结果冒充）

- 真实 Windows 上 git.exe 解析/执行/Job 包含
- MSVC 编译 helper 1.2.0（`--run` 新增分支未在 Windows 编译过）
- `tests/windows/helper-harness.mjs` 的 `--run` 原生用例
- `scripts/windows/packaged-git-test.mjs` 打包态验收
- 打包构建、packaged smoke、安装/卸载
- 真实 provider 凭据/推理

## 诚实限制

- POSIX 进程退出码按 256 取模，本机无法真实产生 1024..1279——`--run` 映射用注入 `spawnImpl` 的合成子进程验证契约，真实验证留给 Windows harness。
- 无 `TIVANO_GIT_EXECUTABLE` 且无标准安装时返回 `no-git`，UI 如实显示而非静默禁用。

## Maintainer review (2026-10-25)

Local scope only. The maintainer independently ran build/typecheck, 735 unit tests and 107 desktop checks; all 12 isolated instances exited. One additional Windows-no-runner refusal regression then passed in the 40-test GitService suite. Windows driver syntax checked after final fixture UUID correction. Windows native/build/application tests remain NOT RUN for 2j.

Corrections: reject unsafe environment overrides, invalid explicit blank executables and nonempty/link config masks; preserve process cleanup uncertainty after post-spawn errors and handle pipe errors; allow the native helper's sequential cleanup budget (50 seconds, with application close still reporting bounded retry). Windows without a contained runner refuses direct Git. Smoke assertions now match the known non-repository fixture instead of accepting arbitrary errors.

The Windows Git driver now creates/selects real UUID threads, records the actual Electron main separately from Playwright's Windows cmd wrapper, validates creation identities, retains failure cleanup evidence and renderer errors, hashes metadata names/types as well as contents, and takes a real panel screenshot. The native run-version case queries its own helper instead of reading a variable initialized only in the orchestrator. An unused simulated helper fixture was removed; it could not represent the Windows 32-bit exit channel on POSIX.

Paths containing a semicolon are explicitly unavailable on Windows because they cannot be represented safely in the Git ceiling list. No restore/apply, network Git or provider credentials are enabled.
