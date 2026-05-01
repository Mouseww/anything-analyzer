# Anything Analyzer v3.6.3

## 新功能

- **页面加载状态指示** — 地址栏底部显示滑动进度条，标签页标题旁显示旋转加载图标，清晰反馈页面加载中状态
- **页面加载失败处理** — 页面加载失败时显示友好的错误页面（含错误码、URL 和重试按钮），替代之前的永久白屏
- **WebSocket 代理支持** — MITM 代理新增 WebSocket (ws:// 和 wss://) 协议转发，支持 WebSocket 请求的捕获和分析

## 修复

- **新标签页白屏** — WebContentsView 默认白色背景导致加载期间出现刺眼白屏，已设置深色背景色与应用主题一致
- **部分网站长时间白屏** — 缺少加载失败处理，页面加载出错后永远停留在白屏状态，无任何反馈

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.3.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.3-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.3-x64.dmg |
| Linux | Anything-Analyzer-3.6.3.AppImage |
