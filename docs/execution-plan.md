# 执行计划

公开路线图：对齐基线、阶段划分与目标、当前进度、验收原则。进度中的测试数字是本地自测或维护者审核的记录，不能当作完整产品验收。本文及 `docs/phase-*.md` 中的「维护者」「maintainer」指当前维护者团队成立之前、由项目所有者完成的审核；现行分工见 [CONTRIBUTING.md](../CONTRIBUTING.md)。证据保存在仓库外的维护者档案中。

## 对齐基线

当前对齐目标为 Mac v2.5.7（2026-11-06 发布），commit `8d1b8c2814f51d105cb5bf4a0e3a6aa04fef8ca1`。v2.2.34（commit `d4c27410553677354bd08e70becd20ebbd240183`）和 v2.0.0 均为历史基线；各阶段记录是对着当时的基线验收的，不因目标变更而改写。v2.5.7 尚未取得本地快照。

v2.0.0 为历史基线（2026-10-22 发布），tag object `dcf12b2b06f581d450d6dc3b8e5c4cce15da179a`，commit `d31e093b356846ff538dd8ba0dc22d62598e4427`。已精确 fetch 标签并核对这两个对象，取得记录见 [source-baseline.json](source-baseline.json)。不以未固定的 main/dev 替代已固定的基线，不在参考中开发或执行来源脚本。已原样保留 LICENSE、THIRD_PARTY_NOTICES.md、TRADEMARK.md；图片、字体及其他资源仍须逐项核对资格。

## 当前进度

### 最新状态（2026-10-29）

最新本地基线为 `e0af84b` 加既有未提交覆盖层。P2N 配置入口经维护者构建、类型检查、919 单测和 172 项桌面检查；25 个隔离实例退出。原生选文件闭环、Windows、打包及真实 Codex 仍未验收。P2L 有逐轮快照和恢复预览，没有 Apply/Undo。终端 SUITE-03 为 3 通过、Ctrl-C 失败、18 未运行；Unicode 已在该范围通过，失败清理结论仍 unknown。打包态 Windows Git 仍未验收。

### 阶段记录（2026-10-25 起）

- 阶段 1、2a、2b 的本地范围已验收。Codex 仅完成离线协议及夹具验证，真实认证、推理尚未运行。
- 阶段 2c 的 Job Object 原生助手已在一台 Windows Server 2022 x64 测试机完成 45 项自测和 24 项外部检查。这是组件验证，不能代表 Electron、终端或完整应用已经支持 Windows。
- 阶段 2d 项目目录绑定、2e 嵌入终端已验收本地开发范围。终端检查点为 `2b3bdb18a7e18f72f9b21cb71839483bf3d0b269`；Windows PTY 与 Electron/Job 助手集成尚未实测。
- 阶段 2f 只读 Git 面板已通过维护者的构建、类型检查、542 项单测和 107 项 Electron 检查。最终截图及提交验收以仓库外维护者档案中的记录为准。检查点后端见下一项；撤销、Hydra、其余功能及安装更新仍待完成。
- 阶段 2g 应用私有检查点和保守恢复预览后端已通过构建、类型检查、582 项单测和 107 项 Electron 回归，12 个隔离实例均退出。尚未接入会话自动快照、UI 或实际恢复；未知路径和索引变化保守保留。Windows 端尚未验收。
- 阶段 2h 已在 Windows Server 2022 x64（管理员）完成内部安装包构建和离线 mock 测试：应用 7b59232，测试脚本 ba9e7d8，22/22 通过，安装包及原始证据已取回并校验 SHA-256。GUI 安装、重启和卸载在测试机上有证据；普通用户 Windows 10/11、真实 provider、Windows 终端/Git 仍未验收。
- Phase 2i: the maintainer accepted the packaged offline application/helper/Job chain on Windows Server 2022 x64 elevated administrator: app 465959f, harness 279df6a, smoke 22/22 and corrected job 38/38, all captured identities dead with no forced final cleanup. Installer and evidence retrieved with SHA256 verification. Original wrapper-PID test failure retained. Real CLI/auth/inference, standard-user Windows 10/11, terminal/Git and updater remain unverified.
- Phase 2j: Windows read-only Git implementation passed local checks. Frozen c79dff8/helper 1.2 then passed native --run 7 and packaged smoke 22 on Windows Server 2022 x64 administrator; packaged Git stalled before repository assertions, and the subsequent packaged Job regression was NOT RUN. These gates remain unaccepted.
- Phase 2k: helper 1.3 adds a compile-time-only Windows terminal validation candidate (ordinary builds OFF). The maintainer corrected ownership testimony, bounded queues/native teardown, capability attestation and acceptance harnesses; all 15 maintainer regressions remain. Latest authoritative-checkout build/typecheck, 42 files/791 unit and 107 E2E passed in one quiet full verify. Earlier failing Ctrl-C run remains recorded separately. MSVC, native ConPTY and packaged terminal candidate remain NOT RUN; local tests do not prove Windows behavior.
- Startup diagnostic: one frozen c79dff8 direct start captured an application-owned Error: Failed to get 'appData' path in resolveDataRootArg. Explicit data-root selection was needlessly preceded by that query. The resolver now evaluates appData only for the packaged default, with 17 local resolver checks. Why the Windows OS query failed remains unknown, and the startup fix has not yet been tested on Windows. The diagnostic's unawaited identity queries serialized as empty objects; its cleanup narrative is not accepted as descendant-cleanup proof.
- Phase 2l: checkpoint integration on e0af84b wires the existing safety backend into real provider turns — synchronous reservation before provider start, before/end capture serialized per thread, trusted structured fileChange attribution, durable bounded ledger, lifecycle invalidation, ledger-identity IPC and a non-mutating restore PREVIEW dialog (no Apply/Undo exists). Local verify: 43 files/801 unit + 125/125 e2e including a real-temp-repo fixture turn, restart-persisted records and preserve classification for staging/partial/drift. Windows Job-runner path is wired but Windows-native acceptance is NOT RUN; apply/undo does not exist.

## 阶段与目标

### 0. 来源冻结（已完成）

固定来源基线并保留许可证、商标与第三方声明文件，见上文「对齐基线」。不导入生产数据或凭据，不复制整套 Mac 源码，不修改 Mac 产品。

### 1. 骨架与合成会话

按 Electron + React + TypeScript 架构建立最小纵向流程、受限 IPC 和隔离开发数据，加入合成会话与测试基础，不先堆功能再补测试。建立完整功能/provider 支持矩阵，记录冻结 Mac 行为、Windows 方案、依赖、验证环境、证据与缺口；合成会话不代表真实 provider 已支持。首个可见界面落实许可证和 About 归属要求。

### 2. 真实 provider、审批、恢复、终端与 Git

逐项接入真实 provider，覆盖审批、取消、错误、恢复与持久化，再接入终端和 Git/worktree。结构化协议与 PTY 分离，保持 IPC 与凭据边界。真实认证仅使用独立开发身份，不自动复制生产凭据。保留真实 provider 证据，不用模拟结果填补未执行项。

### 3. Hydra 与功能补全

实现 Hydra 隔离、任务协作和结果整合，按支持矩阵补全冻结基线的所有功能与产品风格，记录平台适配及剩余缺口。Mac 产品不动；完整对齐是最终目标，不因完成骨架提前宣称完成。

### 4. Windows 平台与安装更新

完成真实 Windows 的平台行为及安装、更新、卸载验证。macOS 上的本地 Electron 开发、合成回放或交叉构建均不能替代真实 Windows 验收。

Windows 构建与平台验证在 Windows 测试机上进行。测试机磁盘不是持久存储：输入采用明确基线的隔离副本，结果、日志和必要证据及时保存到持久位置，不依赖会话继续存活。

产出安装包时，将源代码 commit、安装包 SHA-256、环境和验证证据绑定。签名与发布凭据不进入一般开发流程，签名与发布单独进行。

## 验收原则

每项工作记录基线、输入、验收条件、结果、代码 commit、证据与未验证项；不共享活动源码或生产库。

分别记录以下验证状态，不以合成成功宣称真实环境通过：

- 合成数据与协议回放。
- 真实 Windows 的进程、PTY、Git、存储和凭证行为。
- 真实 provider 的认证、会话、取消与错误处理。
- 桌面交互、截图目检与可访问性。
- 安装、升级与卸载。
