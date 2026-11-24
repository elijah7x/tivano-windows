# Changelog

All notable changes to Tivano Windows are documented here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the package versions without a leading `v`.

## [Unreleased]

## [0.1.0] - 2026-10-23

### English

### New features

- Isolated local data store with exclusive lock protection, corrupt-file preservation, and per-thread turn segments.
- Support for synthetic, synthetic-stdio, and Codex CLI runtimes with approval cards, question prompts, and checkpoints.
- Embedded terminal drawer, read-only Git status and diff panel, branch switching, and commit sheets.
- Full 29-theme palette, Simplified Chinese (`zh-Hans`) localization, custom keyboard shortcuts, and Settings › Version release notes.

### Bug fixes

- Guard untrusted paths, UNC shares, and external links across the sandboxed IPC boundary.

### Refinements

- Keyboard-accessible modals, live theme switching, and adjustable font sizes across UI, content, and code.

### 简体中文

### 新功能

- 独立隔离的本地数据存储，提供独占锁保护、损坏文件保留以及按对话分段的轮次存储。
- 支持模拟、synthetic-stdio 与 Codex CLI 运行时，包含审批卡片、提问交互与检查点恢复。
- 内置终端抽屉、只读 Git 状态与差异面板、分支切换与提交表单。
- 完整 29 款主题配色、简体中文（`zh-Hans`）本地化、自定义快捷键，以及「设置 › 版本」更新内容展示。

### 问题修复

- 在沙箱 IPC 边界拦截不可信路径、UNC 共享路径与外部链接。

### 优化改进

- 弹窗支持键盘无障碍操作、实时主题切换，以及界面、正文和代码字号独立调节。
