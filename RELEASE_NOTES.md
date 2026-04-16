# Anything Analyzer v3.1.0

## 新功能：暂停/恢复抓包

- **Pause → Resume 切换** — 点击 Pause 暂停抓包后，按钮自动变为 Resume，再次点击即可恢复抓包，无需重新开始会话
- **MCP 工具支持** — 新增 `resume_capture` MCP tool，外部 AI Agent 可通过 MCP 控制暂停/恢复

## 改进：LLM 连接错误诊断

之前点击分析失败时只显示 `fetch failed`，用户无法判断原因。现在会根据错误类型给出具体的中文诊断信息：

| 错误场景 | 提示信息 |
|---------|---------|
| API 地址写错 | DNS 解析失败：无法解析 xxx。请检查 API 地址拼写是否正确 |
| 本地中转服务未启动 | 连接被拒绝：xxx 未在监听。请确认该服务已启动 |
| 网络不通 / 被墙 | 网络请求失败：无法连接到 xxx。常见原因：API 地址错误、需科学上网、本地服务未启动 |
| 请求超时 | 连接超时：xxx 在 120 秒内未响应 |
| SSL 证书问题 | SSL 证书错误：无法与 xxx 建立安全连接 |
| 连接被重置 | 连接被重置：可能是代理不稳定或 API 限流 |

## 下载

| 平台 | 文件 |
|------|------|
| Windows | `Anything-Analyzer-Setup-3.1.0.exe` |
| macOS (Apple Silicon) | `Anything-Analyzer-3.1.0-arm64.dmg` |
| macOS (Intel) | `Anything-Analyzer-3.1.0-x64.dmg` |
| Linux | `Anything-Analyzer-3.1.0.AppImage` |
