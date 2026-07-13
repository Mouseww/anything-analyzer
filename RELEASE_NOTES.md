# Anything Analyzer v3.6.52

## 变更

- **统一 tools provider 路由** — 分析与追问复用同一套最新 LLM provider 配置和工具调用协议。
- **修复追问工具调用兼容性** — 规范化 MCP 工具名、兼容 Responses/Chat Completions function schema，并保留真实工具名映射。
- **支持持续工具调用** — 不再因轮次上限或工具异常自动退回无工具请求。
- **优化上下文预算** — 大量请求的预过滤按批次发送，追问上下文使用确定性压缩，避免单次超大请求。

## 修复

- **macOS Intel 打包架构** — 修复 x64 包内 `better-sqlite3` 原生模块被打成 arm64 的问题
  - macOS x64 与 arm64 现在分别在对应 runner 上构建，避免原生依赖交叉污染
  - 发布前会校验 `better_sqlite3.node` 的实际 Mach-O 架构，架构不匹配时阻断 Release

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.52.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.52-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.52-x64.dmg |
| Linux | Anything-Analyzer-3.6.52.AppImage |
