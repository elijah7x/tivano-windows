# 阶段 2k — Windows ConPTY/Job 终端宿主（实现 + 备验，未验收）

实现基线：`c79dff8e416924aaf7a2a4b969570344e7555de4`；本阶段源码身份以最终本地提交及证据清单为准。
本阶段在现有 `tivano-job-helper.exe` 内新增 `--terminal` Windows 原生终端宿主：**ConPTY 伪控制台 + Job Object 在单个 `STARTUPINFOEXW` 属性列表中原子创建**，shell 首条线程执行前即已在 Job 内。普通 Windows 终端**仍为 OFF**；只有显式 `--terminal-candidate` 编译期构建的验证候选才可能开启该路径。**本阶段不是 Windows 终端验收**——MSVC 编译、原生 harness、打包候选全部 NOT RUN。

## 架构（任务书批准版，无回落）

- 宿主形态：现有 helper 第三模式 `tivano-job-helper.exe --terminal <base64url TerminalSpec v1>`。不新增第二个终端架构、不 fork node-pty、不用 shell 包装器。
- 原子创建：一个属性列表同时携带 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 与 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`；Job 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。若目标系统不支持两属性合并，创建直接失败——**禁止** `CREATE_SUSPENDED`/创建后 AssignProcessToJobObject/breakaway/任何回落。
- Shell：仅固定系统 PowerShell——`GetSystemDirectoryW()` 解析 `WindowsPowerShell\v1.0\powershell.exe` + `-NoLogo -NoProfile`。TerminalSpec 不能选择 shell/命令/参数/helper 路径。
- 协议：helper stdin/stdout 上的有界 NDJSON（行 ≤512KiB）；stderr 独立 bounded Diag writer。
  - 主→helper：`input`(base64,有界）、`resize`(2..500×2..200)、`ack`、`pause`/`resume`、`stop`；stdin EOF = owner 停驱动。
  - helper→主：`spawned`/`spawn-failed`/`data`(seq+base64,≤4096 原始字节，仅完整 UTF-8 序列切帧）/`exit`/`cleanup`/`error`。
- 信用流控：未确认输出 ≥128KiB 暂停 ConPTY 读，<32KiB 恢复，512KiB 硬界（防御性——drain 在 128KiB 已停读，正常有界运行不可达，未验证）；待处理输入 ≤256KiB，超限 fail-closed。
- 退出类：`0` 干净退出（shell 自然退+Job 空+输出排空+cleanup 发出）；`2` spec/调用非法（不创建任何 OS 对象）；`3` 启动前设置失败；`4` 清理/I/O 证明失败；`5` `CreateProcessW` 失败（shell 未运行）；`6` 强制拆解（owner 死/stop/协议违例/stall/溢出/自然退出后仍有后代）且 Job 证空。
- 拆解证明：`TerminateJobObject`→轮询 `ActiveProcesses` 至 0（≤10s)→停输入泵→`exit` 帧→**专用有界线程** `ClosePseudoConsole`（老 Windows 构建可能阻塞，**不**在读/监视线程同步调）→排空输出→cleanup 帧（`jobEmpty`/`outputComplete` 如实字段）→flush writer→有界停线程。未知/未证明状态诚实记为失败类，不转 pass。

## 改动面

| 文件 | 内容 |
|---|---|
| `helpers/win32/helper_common.hpp/.cpp` | 新增 TerminalSpec v1 解析（v/ownerPid/cols/rows/cwd/有序 env 对，SAX 深绑+重复键拒绝）、`b64Encode`、`utf8TailBytes`（UTF-8 边界切帧）、env pairs→块、`jsonBoundedOk` 导出；selftest +16 用例（共 77） |
| `helpers/win32/helper_win32.hpp/.cpp`（新） | 从主程序提取共享 Win32 原语：RAII Handle、bounded Diag writer、owner 验证（父 PID+创建时间+活句柄+PID 复用防护）、Job 统计/ActiveProcesses、管道、worker 启动、`stopThreadBounded`(CancelSynchronousIo+有界 join)、peer-closed 分类、UTF-16 转换。`--serve`/`--run` 行为不变（语义逐字保留，仅换 include) |
| `helpers/win32/terminal_mode.hpp/.cpp`（新） | `--terminal` 全实现：spec 先于任何 OS 对象校验→owner 验证→固定 PowerShell 解析→Job+ConPTY 管道+伪控制台→单双属性 `STARTUPINFOEXW`→CreateProcessW 前最后 owner 活性复查→`spawned`→独立 drain/input/watch worker。控制解析走 `jsonBoundedOk` 预扫（防 512KiB 深嵌套 JSON） |
| `helpers/win32/tivano-job-helper.cpp` | `--terminal` 分发；`--version` 升 **1.3.0**：`terminalSpec:1`、mechanisms 增 `conpty-terminal`/`proc-thread-attr-job-list`；serve/run 泵代码不变 |
| `helpers/win32/helper-selftest.cpp` | TerminalSpec/b64/utf8Tail 便携用例（本机已跑 77/77) |
| `scripts/build-job-helper.ps1` | 编译新增 3 个 TU(helper_win32/terminal_mode)+terminal-fixture.exe(BOM 保留） |
| `src/main/windowsTerminalHost.ts`（新） | helper 协议→`TerminalHostHandle` 适配：TerminalSpec 构造（ownerPid/尺寸/cwd/白名单 env)、NDJSON codec、seq/大小/生命周期校验、`post` 转发 input/resize/ack/pause/resume、shutdown 请求 stop，kill 仅请求强制终止。维护者收口：spawn 后须 exit、`cleanup{jobEmpty:true}` 与 helper close 0/6 相符才确认；单独 cleanup 帧或退出码不能释放所有权。2/3/5 仅在没有 spawned 时证明未创建，控制器拒绝启动也可证未创建；null/signal/未知码/矛盾序列一律 unconfirmed——kill 是内核收割**触发器**，不是已观测的 Job 空证明；stdin 背压有界（256KiB wire 界）、严格 base64/seq/生命周期校验、stream error/EPIPE 显式失败 |
| `src/main/terminalService.ts` | 独立 `windowsTerminalReady` 能力 dep；win32 gate 保持（非候选仍 `unsupported`)；win32 spawnMessage 走 helper 路径、`env` 不传 POSIX shell/args;`recoverHost` win32 明确拒绝（无 POSIX PTY 恢复）。repair-1 补充：env 隔离补 `APPDATA`/`LOCALAPPDATA`——与 HOME/USERPROFILE/TEMP/TMP 同落每-incarnation 独立根并在原生启动前建目录（env 隔离非文件/安全沙箱） |
| `src/main/index.ts` | helper attestation 结果注入 `windowsTerminalReady`(win32+packaged+attested+`terminalCapable`)+candidate spawn host；非候选恒 false |
| `src/main/providerProcessLifecycle.ts`+`packagedJobHelper.ts` | `JobHelperMode` 增 `"terminal"`;attestation 解析 `terminalSpec`/`conpty-terminal`/`proc-thread-attr-job-list` → `terminalCapable`；打包 `--version` 契约精确校验 |
| `src/main/buildFlags.d.ts`+`build.mjs` | `TIVANO_TERMINAL_CANDIDATE` 编译期 define，仅 `--terminal-candidate` CLI flag 注入主 bundle literal；默认 undefined→false。env/IPC/设置/helper 存在均不能开启 |
| `scripts/package-windows.mjs` | `--terminal-candidate` 传构建+manifest 记录 `terminalCandidate`+`unsigned/internalDevelopmentOnly/noAutoUpdater` |
| `src/main/engine.ts`+`shared/types.ts` | `AppInfo.terminalCandidate?: true` 如实上报 |
| `tests/windows/terminal-fixture.cpp`（新） | 会话内工具：marker（`PID:pid:ticks:INJOB:n:PARENT:ppid`,FILETIME 身份）、`waitfile`、console 观察、`breakaway`(`CREATE_BREAKAWAY_FROM_JOB` 真实尝试） |
| `tests/windows/terminal-harness.mjs`+`terminal-owner-runner.mjs`（新） | Windows-only 原生验收驱动（非 Windows exit 4):22 用例见下；逐 case 隔离 runner、身份化存活证据、cleanup 未证实即中止套件 |
| `scripts/windows/packaged-terminal-test.mjs`（新） | 打包候选应用层验收（备而不用）:IPC 终端创建/输入/尺寸、candidate 标识、app 死亡→Job 收割、身份证据。非候选包直接拒绝；普通包的终端禁用状态由 packaged smoke 单独检查 |
| `tests/windowsTerminalHost.test.ts`（新） | 合成子进程全协议回归 14 用例：spawned/data seq/ack/resize/pause-resume/input/stop/违规 fail-closed/owner-death/spec 编码 |
| `tests/terminalService.test.ts`+`packagedJobHelper.test.ts` | win32 候选门禁用例、terminalCapable 解析用例增补 |
| `config/cloud-source-manifest.json` | 精确 include 新 helper/fixture/harness/测试输入；`tests/**` 排除注释澄清 |

## 原生 harness 用例（22,Windows 门禁）

capability 广告、自然 shell 退出、Unicode 往返（重渲染下取可判定证据非字节守恒）、输入回显+Ctrl-C、resize、无菌环境/无泄漏、后代包含+marker 身份、console 附着、shell 退出留活后代→强制清理、显式 stop、helper 被杀→会话树收割、owner 死亡拆解、credit pause/resume(128KiB 真实可达语义）、大输出已确认完整流、协议违例、spec 拒绝、spawn 前有界输入、重复会话/重启、breakaway 包含尝试、显式 pause/resume、stdout stall、input overflow。

驱动纪律：`--version` 能力缺席=前置失败非跳过；逐用例记 helper PID/创建身份与 marker 树活性；cleanup 失败/未证实即中止；总时限+进程收尾。

## 候选门（普通用户 OFF 的完整证明链）

```
TIVANO_TERMINAL_CANDIDATE === true   编译期 literal,仅 scripts/build.mjs --terminal-candidate
  && process.platform === "win32"
  && app.isPackaged
  && attestation.supported && helper.terminalCapable   --version 实测 terminalSpec:1+双机制
```

manifest 如实写 `terminalCandidate:true`+`unsigned/internalDevelopmentOnly/noAutoUpdater`；普通包 `terminalCandidate:false`，该字段在 manifest 恒显式。

## 初次实现验证（历史，本机 darwin/arm64)

- 便携 C++ selftest:**77/77**（含 TerminalSpec/编码器新用例）
- 聚焦：`windowsTerminalHost` 14/14；`terminalService`+`packagedJobHelper`+`helper-core`+`windowsTerminalHost` = 77/77
- `npm run verify` → exit 0:build+tsc 0 错+**41 文件/755 单测**+**107/107 e2e**(macOS 终端用例全过，零回归）
- 语法：`terminal-harness.mjs`/`terminal-owner-runner.mjs`/`packaged-terminal-test.mjs` node --check 通过；ps1 BOM `efbbbf` 保留

## 明确 NOT RUN（不得以本机结果冒充）

- MSVC 编译 helper 1.3.0（新 TU `helper_win32`/`terminal_mode`,`/W4 /WX` 可能有告警需修）
- `terminal-harness.mjs` 全部 22 原生用例（ConPTY/JOB_LIST+PSEUDOCONSOLE 合并属性仅 Windows 可证）
- Windows 版本/构建支持评估（`ClosePseudoConsole` 阻塞行为、双属性合并可用性）
- 打包候选构建+`packaged-terminal-test.mjs`
- helper 1.3.0 的打包 attestation 与原生回归（不能借用 1.2.0 的原生 7 项、打包 smoke 22 项证据；1.2.0 的完整打包 Git 因启动失败仍未验收）
- packaged smoke、安装/卸载、签名、更新
- 真实 provider 凭据/推理

## 诚实限制

- `--run`/`--serve` 源码经共享提取重构（语义不变）但 1.3.0 二进制未编译——旧二进制证据不适用。
- credit 512KiB 硬界在 128KiB 暂停语义下正常不可达；harness 测可达的 pause/resume 与已确认大输出，硬界仅防御性保留。
- ConPTY 输出经伪控制台重渲染，Unicode 用例取确定性证据而非逐字节断言。
- helper 被杀（SIGKILL）时 `exit`/`cleanup` 帧无法发出——harness 以进程退出+marker 树死亡为证，不要求协议收尾。
- TerminalSpec 的 JSON env 对象在 helper 侧转为键值对，再按 Windows 环境块要求排序；不能依赖 JSON 对象插入顺序。win32 应用侧仅传白名单最小集。
- fixture 的 `IsProcessInJob(self,NULL)` 只证明属于某个 Job；不能单独证明属于本终端的特定 Job。目标 Job 的原子创建、普通后代继承与退出行为仍需结合原生调用和真实 Windows 证据判断。

## repair-1（2026-10-25,维护者回归修正）

维护者复跑 verify 全绿后补 9 个模拟子进程回归（`tests/windowsTerminalHost.lead.test.ts`)，全部可复现失败，本轮修正（仅 TS adapter/service 与其测试，原生 C++/harness/打包文件只读）:

- **清理声明改为纯证词制**:adapter 曾把 `code!==4` 一律视为已证空（含 null/17)——已移除该推断。原 repair-1 曾允许单独 cleanup 帧或 0/6 退出码确认；维护者后续回归证明仍可能隐藏迟到失败，现改为完整 exit/cleanup/close 一致才确认。2/3/5 且无 spawned、或控制器可证未创建，才可作未创建处理。null/signal/未知码/矛盾序列 → unconfirmed,restart/capacity/dispose 不得遗忘为成功。
- **运行时 `error` ≠ spawn 失败**：子进程存活期 `error` 事件只报 host-error，不发 cleanup/exit，持所有权至真实 close。
- **pre-spawned shutdown**:stop 经控制直发（helper 控制 reader 在 spawned 前即分发），并闩锁 cancelled——迟到的 spawned 不可复活会话/准入输入/启动替代。
- **超预算 spec**：编码拒绝（控制器可证未创建）→ spawn-failed+vacuous cleanup+exit，释放容量。
- **stdin 背压**:输入 wire 界 256KiB，另保留 64KiB 控制预算；控制量也必须有界，超限显式失败并请求终止，shutdown 合并发送。
- **严格入站帧**：严格 base64 字母/填充、decoded ≤4096B、seq 必须连续、生命周期顺序（spawned 前 data/exit/cleanup 均违例）、重复终态帧 fail-closed。
- **stream error/EPIPE**:stdin/stdout/stderr `error` 事件显式 host-error；协议传输死亡→强制拆解，管道错误不等于清理证明。
- **env 隔离补全**:win32 spawn env 增 `APPDATA`/`LOCALAPPDATA`(per-incarnation、启动前建目录），六根（HOME/USERPROFILE/TEMP/TMP/APPDATA/LOCALAPPDATA）全在该终端独立根内，不继承宿主 profile/凭据；env 隔离非文件/安全沙箱。

## 维护者收口（2026-10-25）

- 追加 6 条回归，复现迟到 helper 失败被早到 cleanup 隐藏、控制队列无界、协议错误后继续采信帧及 stderr 停读；维护者直接修正。首批 9 条和追加 6 条均保留。
- 原生设置失败也以独立有界线程关闭 ConPTY；取消与创建提交串行；最终协议输出先等真实 flush/join，不能取消最后一次 WriteFile 后称成功。便携 base64 拒绝错误填充，fixture 缓冲区越界检查补齐。
- 验收脚本修正 PowerShell 拼接表达式、环境根、conhost 创建身份与未知查询处理、输入回显误判、实际 Electron main 终止和 boundedClose 参数；不得用包装 cmd.exe 退出证明应用退出。打包驱动新增必需的 `--launcher <codex-launcher.exe>`。
- 维护者本地检查：build、tsc 与 42 文件/783 单测通过。首次完整 `verify` 在 macOS 洪流 Ctrl-C 检查超时退出 1，当时有桌面自动化正在操作另一前台应用；不能将其记成全量通过。此后在保持前台无人操作的条件下单独跑 E2E，107/107、exit 0。测试仅补失败诊断，不放宽断言；这次对照尚不能独立证明首轮超时的根因。
- 结果与首轮失败的证据保存在仓库外的维护者档案中。MSVC、ConPTY 和打包候选仍 NOT RUN；普通 Windows 门禁保持关闭。

## 阻塞与交接

- 若目标 Windows 系统拒绝 `JOB_LIST`+`PSEUDOCONSOLE` 合并属性（CreateProcessW ERROR_INVALID_PARAMETER)，按任务书**报告阻塞、禁止回落**——harness `spawn-failed`/类 5 如实呈现。
- 候选是否保持验证专用由维护者在取得 Windows 证据后决定；本阶段未授权普通用户开启。

## startup-trace（2026-10-27,WIN-P2K-STARTUP-TRACE-01,仅仪器化不修猜测）

维护者证据（SHA256 `66e8b9af…8c659` 已核；证据保存在仓库外的维护者档案中）显示案例在 VM 上约 19s 后失败且摘要没有 exit/cleanup/error。该摘要不含 spawned/data；当时不能证明 helper 零帧或停滞于创建期。2026-10-28 的 trace 已记录创建成功及 spawned 写出，接收与提示符情况仍需下节诊断。本轮只加有界、显式启用的启动阶段轨迹，不改任何生命周期/并发语义:

- **opt-in**:`tivano-job-helper.exe --terminal <base64url-spec> --startup-trace`。该开关仅 terminal 模式、显式第 4 参数；serve/run 与任何其他第 4 参数仍走 usage 拒绝；3 参冻结调用形不变。非 secret、出现在进程命令行中可审计。
- **通道与有界**:全部标记经既有 `Diag`（≤448 字符/行、≤64 条队列、溢出丢弃计数、专用写线程）写 **stderr**——生命周期线程只 enqueue 永不阻塞；stdout 协议面零变化；关闭时零成本（`if (!g_traceOn) return`)。
- **格式**:`tivano-job-helper: trace t=<ms-since-mode-entry> <stage> [k=v]`。内容仅阶段名、单调毫秒、helper 身份（version+pid+创建 FILETIME ticks，与 driver `launched.json` 可直接关联）、cols/rows/尺寸数字与 native err/HRESULT。**绝不**含 spec/env/路径/输入/命令行字节（`terminal-trace-source.test.ts` 源码断言）。

### 阶段标记（按启动顺序）

`armed ver= pid= cticks=` → `spec-accepted cols= rows=` → `stdio-ok` → `events-ok` → `worker-start writer|reader` → `owner-verified` → `shell-located` → `env-block-ok bytes=` → `job-configured` → `pipes-created` → `conpty-create-begin`/`conpty-create-end hr=` → `attr-list-init bytes=` → `attr-job-set` → `attr-conpty-set` → `createprocess-begin`/`createprocess-end pid=`(或 `createprocess-failed err=`)→ `spawned-enqueued` → `writer-flushed <首40字符>`（仅表示控制帧 WriteFile 完成，不证明对端收到或解析；data 帧不逐条记）→ `worker-start drain|input` → `watch-entered` → `watch-exit why=<0..12>` → `teardown-begin forced=` → `job-empty empty= ms=` → `exit-enqueued` → `worker-start hpcon-close` → `hpcon-close-begin|end` → `cleanup-enqueued jobEmpty= outComplete=` → `exit cls=<类>`(或 `hard-exit cls=`)。线程侧：`reader-eof[ err=]|reader-stop|reader-cancel|reader-oversize|reader-protocol-stop`、`drain-read-err`、`drain-end why=`、`input-dead err=`、`writer-dead err=`、`spawn-fail code=`、`failpath-flush-done`。why 枚举:0 none,1 natural,2 owner-dead,3 stop,4 eof,5 protocol,6 credit,7 input-overflow,8 out-overflow,9 stall-out,10 stall-in,11 io-fatal,12 drain-lost。

### MS 文档差异（仅记录，未改）— learn.microsoft.com/windows/console/creating-a-pseudoconsole-session

1. 官方样例注释 `// - Close these after CreateProcess of child application` 且正文要求 CreateProcess 完成后才释放传入句柄（"the handles given during creation should be freed"),**当前代码在 `CreatePseudoConsole` 返回后立即 `CloseHandle(inRd/outWr)`**（位于 attr 设置与 CreateProcessW 之前）。若 CreatePseudoConsole 未内部留存管道端，提前关闭可能使 conhost 持有已断通道——与观测到的启动期静默停滞相容但**未证实**。
2. 官方警告：各通信通道须由独立线程服务，否则同步 I/O 可死锁（"Servicing all of the pseudoconsole activities on the same thread may result in a deadlock")。**当前 drain 线程在 `CreateProcessW` 之后才启动**——CreatePseudoConsole 至 drain 启动之间输出管道无人排空，会话初始化输出若填满管道缓冲可使 conhost 侧阻塞。同样未证实。
3. 文档 "Failure to manage the lifetime of HANDLEs correctly can result in deadlock scenarios, especially with synchronous I/O calls"——会话期多线程 I/O 设计符合，但上述启动窗口与句柄时序差异是真实存在的审查点。

### 残余诊断盲区（如实）

- trace 看不到 CreatePseudoConsole/CreateProcessW 内部（内核/conhost 侧）——begin/end 对只能定位"卡在哪次调用"，不能说明卡内原因。
- `writer-flushed` 只覆盖控制帧；若 Diag 队列先被刷屏丢弃，stderr 证据本身也可能缺失（`dropped` 计数在 stop 时补一行）。
- helper 被杀（SIGKILL/宿主强杀）路径无任何收尾标记可发。
- stderr 若未被驱动方捕获（生产 adapter 不转发）则标记无落点——诊断 run 的 driver 必须捕获 helper stderr(harness 已有 `h.stderr`,≤64KiB)。

## session-diagnostics（2026-10-28,WIN-P2K-SESSION-DIAG-02,仅证据不修 ConPTY）

**修正**:维护者 trace 报告此前的"helper 零帧"说法不成立——当时 harness 只保留 runner stdout(RESULT 行）与内存 stderr,helper stdout 从未落盘，"无帧"是无法证明的。本轮把 stdout ingestion 提取为共享模块 `tests/windows/terminal-session.mjs`（生产 harness 与聚焦测试共用同一代码路径，非测试副本），并加入**显式 opt-in** 的有界会话证据；协议语义、断言、超时（spawned 30s/prompt 15s)、轮询节奏（50/60ms)、ACK 顺序与全部上限逐字不变。

- **开关**:`TIVANO_TERMINAL_DIAGNOSTICS=1`（仅 harness 环境，非用户 CLI)。仅此时 helper argv 追加 `--startup-trace` 且创建证据文件；默认不创建诊断文件；正常会话解析经共享模块执行，拒绝案例的 minimal launcher 保留原解析路径。
- **证据文件**（每 helper，`wx` 独占、增量写、绝不覆盖旧运行）:
  - `helper-<pid>-<seq>.stdout.bin` ≤256KiB,`helper-<pid>-<seq>.stderr.bin` ≤64KiB——各自记 `observedBytes/retainedBytes/truncated`；截断不停解析、不触发 kill。
  - `helper-<pid>-<seq>.snap-<k>.json` ≤5 个、每个 ≤64KiB——stage 边界（spawned-wait/prompt-wait 的 start/end/not-started，含 UTC+单调耗时与 success/timeout/error)+ post-cleanup 终态；内容为固定帧计数（含 `other`)、解析/畸形计数、≤4KiB base64 尾（pending-line 与已解码输出）、有界错误列表。**不**记 spec/env/输入/完整帧副本/任意帧类型键。
- **失败安全**：诊断 create/write/close 错误一律捕获、有界留存、在原始 teardown 之后、输出 RESULT 之前合并——任一诊断 I/O 错误强制 `pass:false` + `cleanup:"unknown"`，原始失败 detail **追加**而非替换，绝不把结果升级为 clean。
- **维护者验证**：追加 5 条回归先复现失败，再修正短写耗尽未报错、最终快照槽位、UTF-8 字节上限与等待异常记录；恢复 minimal launcher 原行为。两文件共 51 项测试、分别执行的两个 `node --check` 与 `tsc --noEmit` 通过；未做 Windows 实跑。
- **界限**：证据只回答"helper 实际发了什么字节、runner 收到什么"；不证明 ConPTY 内部状态，不修上一节记录的两个 MS 文档差异。

## stdio-isolation candidate (2026-10-28)

SESSION-CLOUD-02 raw bytes proved one parsed spawned frame and one data frame, followed by a 35-byte unframed PowerShell prompt. The prompt wait timed out; this does not prove all subsequent output bypasses framing. Original failure and cleanup unknown remain archived.

The candidate explicitly sets STARTF_USESTDHANDLES with null hStdInput/hStdOutput/hStdError, retaining bInheritHandles=FALSE and the combined JOB_LIST/PSEUDOCONSOLE attributes. This matches Microsoft node-pty's ConPTY launch at [f6991751](https://github.com/microsoft/node-pty/blob/f6991751bd86b4e40437917f6ae5f9a44738f6bb/src/win/conpty.cc). The general [STARTUPINFO contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow) describes valid inheritable handles with TRUE; it is not independent proof of this null-handle ConPTY pattern. [Microsoft's introductory sample](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) does not specify this flag. Treat this as a source-backed candidate requiring Windows execution, not a proven general API guarantee.

No change to ConPTY pipe-close timing, drain ordering, Job containment or cancellation. STDIO-CLOUD-01 compiled the candidate and passed the natural-exit case: framed prompt/input, unforced shell exit 7, both cleanup flags and helper exit 0. TERMINAL-SUITE-02 repeated that success, then stopped at Unicode: 2 passed, 1 failed, 19 unrun (the report's fourth entry is a stop sentinel, not a case). Neither run accepts the full terminal or packaged product.

## Native command environment and Unicode fixture (2026-10-28)

UNICODE-DIAG-01 recorded `success:true, nativeExit:null` with no fixture output; the prior `exit=0` summary meant helper exit, not fixture exit. UNICODE-ENV-02 changed only the spec's fixed `PATHEXT` to `.COM;.EXE;.BAT;.CMD`: native exit became 0 and ASCII output arrived. CJK remained mojibake. The shell reported an additional `.CPL`; its origin was not established. All original failures retain `cleanup:unknown`, even with later observations that owned processes were gone.

The product and harness now explicitly set the same fixed `PATHEXT`, never inherit the host's value. [PowerShell 5.1 command precedence](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence?view=powershell-5.1) documents how executable extensions control dispatch. This does not extend filesystem or process permissions.

The fixture had sent UTF-8 bytes to a console without selecting UTF-8 as its output code page. ConPTY's UTF-8 wire does not change that console API contract. Its wide-text path now uses `GetConsoleMode` and `WriteConsoleW` for a console, retaining explicit UTF-8 `WriteFile` for redirected output, as described by [Microsoft](https://learn.microsoft.com/en-us/windows/console/writeconsole). It does not change the session's code page or the helper's lifecycle. This corrects the test payload; it is not a general fix for third-party applications that emit bytes in the wrong code page.

The Unicode case now records native status separately, waits for complete output, and requires unforced shell exit, both cleanup flags and helper exit 0. The shared harness decoder also retains UTF-8 state across separate data frames; two regressions cover byte-by-byte payloads, ACKs, incomplete EOF and session isolation. The product environment and decoder regressions were reproduced before correction. Maintainer verification passed 87 focused tests, both harness syntax checks and TypeScript checking.

TERMINAL-SUITE-03 compiled the corrected fixture once with MSVC `/W4 /WX`, retained the exact prior helper, and passed byte-exact redirected UTF-8 output (24 bytes). Unicode passed through ConPTY with actual CJK/ASCII output, native status `True:0`, unforced shell exit 0, both cleanup flags and helper exit 0. The maintainer independently checked archived input/source/build identities and raw frames. The suite stopped at the next failure: **3 passed, 1 failed, 18 unrun**; the stop sentinel is not a case.

The failing `input-echo-and-ctrl-c` case returned ordinary echo output but no response after the sleep command and ETX submission. Captured helper stdout contains 15 valid frames (spawned + 14 data), no exit/cleanup frame, and no diagnostic I/O error; helper rescue was required. Preserve `cleanup:unknown`. The harness text claiming the interrupt killed the session is not established by this evidence. Input delivery, console control processing and shell response remain to be distinguished; no Job/lifecycle relaxation is justified. Full suite, packaged terminal and ordinary-user Windows acceptance remain pending.
