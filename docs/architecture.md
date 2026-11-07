# 架构方向

## 产品与基线

Tivano Windows 是独立产品，采用 Electron + React + TypeScript，不重写 Tivano Mac。功能与产品风格对齐 Mac；窗口、路径、快捷键、进程和凭证等系统行为允许合理的 Windows 适配。

完整功能对齐是最终目标，不是当前支持声明。当前对齐目标为 Mac v2.2.34，commit 为 `d4c27410553677354bd08e70becd20ebbd240183`（v2.0.0 `d31e093b356846ff538dd8ba0dc22d62598e4427` 为历史基线），来源见 [source-baseline.json](source-baseline.json)；不跟随 main/dev。逐项建立功能/provider 支持矩阵。矩阵至少记录 Mac 行为、Windows 方案、依赖、验证环境、证据和缺口，不能默认所有 provider 兼容。

## 分层与边界

| 层 | 职责与约束 |
| --- | --- |
| Renderer：React + TypeScript | 呈现界面与交互；只调用受限 IPC，不直接访问系统、凭证或任意执行进程。 |
| IPC 边界 | 暴露明确、最小化的操作；校验请求、权限与输入，不提供任意命令通道。 |
| 应用服务层 | 编排会话、任务、审批与取消；协调 provider、Git、Hydra 和存储。 |
| Provider / Git / Hydra / 存储 | 分离协议、仓库操作、协作流程与持久化；不依赖 renderer，生产数据不进入开发环境。 |
| Windows 适配层 | 处理进程生命周期、路径与编码、PTY 和凭证存取；具体机制待真实 Windows 验证。 |

协议 stdio 与交互 PTY 分离：结构化协议不经终端模拟器转发，交互终端也不冒充协议通道。xterm.js / node-pty 仅为候选，尚未验证，不代表已经采用、安装或确认兼容。

## 待验证事项

- Windows 目标架构、Electron 与原生 PTY 依赖的构建/分发组合。
- 各 provider 的协议、安装、认证、进程退出与取消行为。
- Git/worktree、Hydra 隔离与协作、存储恢复和 Windows 凭证边界。
- 桌面交互、可访问性、安装/升级/卸载及产品风格对齐。

已保留冻结来源的 LICENSE、THIRD_PARTY_NOTICES.md 和 TRADEMARK.md，遵守 AGPL、来源与归属义务。第三方依赖与资源许可仍须在引入前核对。不复制整套 Mac 源码、未核实资格的资源或生产凭据。
