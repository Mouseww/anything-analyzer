# Anything Analyzer v3.5.6

## 修复

- **macOS x64 版本原生模块架构错误** — 修复 CI 在 Apple Silicon runner 上交叉编译 x64 时 `better-sqlite3` 等原生模块仍为 arm64 的问题，将 macOS x64 构建改为在 Intel runner (`macos-13`) 上执行

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.5.6.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.5.6-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.5.6-x64.dmg |
| Linux | Anything-Analyzer-3.5.6.AppImage |
