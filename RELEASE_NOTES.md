# Anything Analyzer v3.2.1

## Bug Fixes

- **修复 macOS 异常退出** — 解决 macOS 下关闭应用时进程未正确清理导致的异常退出问题（感谢 @captain686 PR #17）
  - 优化 CaptureEngine 停止逻辑，增加错误处理
  - 改进主进程退出流程，确保所有资源正确释放
  - TabManager 增加销毁方法，清理 WebContentsView
  - Window 增加关闭前清理钩子

## UI 优化

- **抓包控件增强** — Inspector 视图添加 Start/Pause/Resume/Stop 控件，MITM 模式下无需切换到浏览器即可控制抓包
- **按钮可见性提升** — 放大 Start 按钮和 pill 控件，提升操作区域的可发现性
- **Session 状态修复** — 移除错误的"待分析"状态判断，简化为 Running/Paused/Stopped 三状态
- **侧边栏美化** — 卡片式布局、状态圆点脉冲动画、域名预览、Session 计数徽章、自定义滚动条

## 其他

- README 添加使用说明链接

## 下载

| 平台 | 文件 |
|------|------|
| Windows | `Anything-Analyzer-Setup-3.2.1.exe` |
| macOS (Apple Silicon) | `Anything-Analyzer-3.2.1-arm64.dmg` |
| macOS (Intel) | `Anything-Analyzer-3.2.1-x64.dmg` |
| Linux | `Anything-Analyzer-3.2.1.AppImage` |
