[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/mouseww-anything-analyzer-badge.png)](https://mseep.ai/app/mouseww-anything-analyzer)

# Anything Analyzer

[简体中文](README.md) | [English](README.en.md)

> **网页、桌面应用、终端命令、Python 脚本、手机 App —— 不管流量从哪来，抓到就能让 AI 自动逆向分析。**

[![Electron](https://img.shields.io/badge/Electron-35-blue)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

<img alt="Anything Analyzer Screenshot" src="https://github.com/user-attachments/assets/87f24186-ea00-4a03-9634-4d7af4b224d4" />

---

## 为什么用 Anything Analyzer？

传统工具各管一摊：DevTools 只看浏览器、Fiddler/Charles 只做代理、Wireshark 看不了 HTTPS。抓完包还得自己翻几百条请求，手动分析。

**Anything Analyzer 不一样 —— 全场景抓包 + AI 自动分析：**

```
  网页          桌面应用         终端            脚本          手机/IoT
  Chrome       Postman         curl/wget      Python        App / 小程序
    │          Electron          │             Node.js          │
    │            │               │               │              │
    ▼            ▼               ▼               ▼              ▼
 ┌──────────┐ ┌─────────────────────────────────────────────────────┐
 │ 内嵌浏览器 │ │              MITM 代理 (端口 8888)                   │
 │   (CDP)   │ │   系统代理 / 手动指定 / Wi-Fi 代理                    │
 └─────┬─────┘ └──────────────────────┬──────────────────────────────┘
       │                              │
       └──────────┬───────────────────┘
                  ▼
        ┌─────────────────┐
        │  统一会话 Session  │  ← 所有来源的请求汇入同一个会话
        └────────┬────────┘
                 ▼
        ┌─────────────────┐
        │   AI 智能分析     │  ← 一键生成协议逆向 / 安全审计 / 加密分析报告
        └─────────────────┘
```

---

## 三大核心能力

### 1. 全场景抓包 — Anything，不止浏览器

| 抓包对象 | 怎么抓 | 典型场景 |
|---------|--------|---------|
| **网页** | 内嵌浏览器直接操作 | 网站 API 逆向、OAuth 登录、前端加密 |
| **桌面应用** | MITM 代理 + 系统代理 | Postman、Electron 应用、游戏客户端 |
| **终端命令** | MITM 代理 + 环境变量 | curl、wget、httpie |
| **脚本程序** | MITM 代理 + 代码配置 | Python requests、Node.js fetch、Go http |
| **手机 / 平板** | MITM 代理 + Wi-Fi 代理 | iOS/Android App、小程序、H5 |
| **IoT / 其他设备** | MITM 代理 + 网关代理 | 智能家居、嵌入式设备的 HTTP 通信 |

所有来源的请求**统一汇入同一个 Session**，AI 分析时一并处理。

### 2. AI 智能分析 — 不只是抓包，是自动理解协议

- **两阶段分析** — Phase 1 智能过滤噪声请求 → Phase 2 聚焦深度分析
- **5 种分析模式** — 自动识别 / API 逆向 / 安全审计 / 性能分析 / JS 加密逆向
- **JS Hook 注入** — 自动拦截 fetch、XHR、crypto.subtle、CryptoJS、SM2/3/4 等加密调用
- **加密代码提取** — 从 JS 文件中自动提取加密相关代码片段
- **流式输出 + 多轮追问** — 报告实时流式显示，可继续追问细节

### 3. MCP 生态集成 — AI Agent 的抓包工具

- **MCP Client** — 接入外部 MCP Server（stdio + StreamableHTTP），扩展 AI 分析能力
- **内置 MCP Server** — 将抓包和分析能力暴露为 MCP 工具，可被 Claude Desktop、Cursor 等直接调用

---

## 使用场景

| 场景 | 流量来源 | 你能得到什么 |
|------|---------|-------------|
| **逆向网站 API** | 内嵌浏览器 | API 端点文档 + 鉴权流程 + Python 复现代码 |
| **逆向 App 协议** | 手机 Wi-Fi 代理 | App 的隐藏 API + 请求签名逻辑 |
| **JS 加密逆向** | 内嵌浏览器 + JS Hook | 加密算法识别 + 流程还原 + Python 实现 |
| **安全审计** | 浏览器 + 代理混合 | Token 泄露、CSRF/XSS 漏洞、敏感数据暴露 |
| **调试 CLI 工具** | 终端 curl/httpie | 完整请求/响应记录 + AI 解读每一步 |
| **调试微服务** | 脚本 + 环境变量代理 | 服务间调用链路 + 认证流转分析 |

---

## Anything Analyzer — 使用说明

[使用说明](USAGE.md) 

---

## 快速开始

### 下载安装

从 [Releases](https://github.com/Mouseww/anything-analyzer/releases) 下载对应平台安装包：

| 平台 | 文件 |
|------|------|
| Windows | `Anything-Analyzer-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `Anything-Analyzer-x.x.x-arm64.dmg` |
| macOS (Intel) | `Anything-Analyzer-x.x.x-x64.dmg` |
| Linux | `Anything-Analyzer-x.x.x.AppImage` |

### 抓网页 — 内嵌浏览器

1. **配置 LLM** — Settings → LLM，填入 API Key（支持 OpenAI / Anthropic / 任何兼容 API）
2. **新建 Session** — 输入名称和目标 URL
3. **操作抓包** — 在内嵌浏览器中操作网站，点击 Start Capture
4. **AI 分析** — 停止捕获，点击 Analyze，选择分析模式

### 抓应用/终端/手机 — MITM 代理

1. Settings → MITM 代理 → **安装 CA 证书**
2. **启用代理**（默认端口 `8888`）
3. 根据场景配置代理：

```bash
# ---- 终端命令 ----
curl -x http://127.0.0.1:8888 https://api.example.com/data

# ---- Python 脚本 ----
proxies = {"http": "http://127.0.0.1:8888", "https": "http://127.0.0.1:8888"}
requests.get("https://api.example.com/data", proxies=proxies)

# ---- Node.js ----
HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 node app.js

# ---- 系统全局（桌面应用自动走代理）----
# Settings 中一键开启「设为系统代理」

# ---- 手机 / 平板 ----
# Wi-Fi 设置 → HTTP 代理 → 手动 → 填入电脑 IP + 端口 8888
# 然后用手机浏览器访问代理地址下载并安装 CA 证书
```

4. 新建 Session（URL 可留空）→ Start Capture → 外部应用流量自动汇入

<details>
<summary>CA 证书详细说明</summary>

- 证书存储：`%APPDATA%/anything-analyzer/certs/`（Windows）/ `~/Library/Application Support/anything-analyzer/certs/`（macOS）
- 首次安装需管理员权限（Windows UAC / macOS 密码）
- Settings 中可随时卸载、重新生成或导出证书
- 根 CA 有效期 10 年，子证书 825 天（符合 Apple 要求）
- MITM 代理为**只读捕获**，不修改请求/响应内容
- WebSocket 流量隧道转发，不做解密
- 单个 body 上限 1MB，二进制内容自动跳过

</details>

---

## 全部功能

<details>
<summary>展开查看完整功能列表</summary>

**抓包引擎**
- 全量网络捕获 — CDP Fetch 拦截，所有 HTTP 请求/响应（含 headers、body）
- MITM 代理 — 内置 HTTPS 中间人代理，自动签发 TLS 证书，按域名 LRU 缓存
- 双通道捕获 — 浏览器 CDP + MITM 代理，统一汇入同一会话
- SSE / WebSocket 识别 — 自动检测流式通信和 WebSocket 升级请求
- 存储快照 — 定时采集 Cookie、localStorage、sessionStorage 变化
- Domain 过滤 — 请求列表按域名分组过滤，支持部分匹配搜索
- 请求来源标记 — 区分「CDP」和「代理」来源
- 导出请求 — 原始请求数据导出为 JSON 文件

**浏览器**
- 多标签页 — 支持弹窗自动捕获为内部标签（OAuth 流程友好）
- 标签页防护 — 阻止 `window.close()` 关闭标签页，最后一个标签页被意外销毁时自动恢复
- 一键清除环境 — Cookies、localStorage、sessionStorage、缓存一键清空

**AI 分析**
- 两阶段分析 — Phase 1 智能过滤 → Phase 2 深度分析，AI 按需查看请求详情
- 手动多选分析 — 勾选指定请求直接分析，跳过预过滤
- 自定义 Prompt 模板 — 内置多种模板，支持自定义
- 流式输出 + 追问 — 报告实时显示，支持多轮对话

**系统**
- 系统代理集成 — 一键设为系统代理（Windows 注册表 / macOS networksetup / Linux gsettings）
- CA 证书管理 — 安装 / 卸载 / 重新生成 / 导出，跨平台支持
- 全局代理 — 支持 SOCKS5/HTTP/HTTPS 代理
- 自动更新 — 内置 electron-updater
- 暗色主题 — 基于 Ant Design 的现代界面

</details>

---

## 从源码构建

```bash
git clone https://github.com/MouseWW/anything-analyzer.git
cd anything-analyzer
pnpm install
pnpm dev        # 开发模式
pnpm test       # 运行测试
pnpm build && npx electron-builder --win  # 构建 Windows 安装包
```

> macOS 发布说明：自动更新依赖**已签名且已公证**的安装包。GitHub Actions 发布 mac 版本前，请在仓库 Secrets 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，否则 `ShipIt` 无法安装更新。

**环境要求：** Node.js >= 18 · pnpm · Visual Studio Build Tools (Windows)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 35 + electron-vite |
| Frontend | React 19 + Ant Design 5 + TypeScript |
| Database | better-sqlite3 (local SQLite) |
| Protocol | Chrome DevTools Protocol (CDP) |
| Proxy | 内置 MITM HTTPS 代理（node-forge TLS） |
| AI | OpenAI / Anthropic / Custom LLM（Chat Completions + Responses API） |
| AI 扩展 | MCP Client（stdio + StreamableHTTP）+ 内置 MCP Server |

<details>
<summary>项目结构</summary>

```
src/
├── main/                    # Electron main process
│   ├── ai/                  # AI 分析流水线（两阶段编排、prompt、LLM 路由）
│   ├── capture/             # 抓包引擎（CDP Fetch + JS Hook + 存储快照）
│   ├── cdp/                 # Chrome DevTools Protocol 管理
│   ├── proxy/               # MITM 代理（CA 管理、证书签发、系统代理）
│   ├── mcp/                 # MCP Client + 内置 MCP Server
│   ├── db/                  # SQLite 数据层
│   └── session/             # 会话生命周期管理
├── preload/                 # Context bridge + Hook 注入脚本
├── renderer/                # React UI（组件 + Hooks）
└── shared/                  # 共享类型定义
```

</details>

---

本项目`不具备`以下能力：
- 不具备【非法获取计算机数据】的功能
- 不具备【非法修改计算机数据】的功能
- 不具备【非法控制计算机系统】的功能
- 不具备【破坏计算机系统】的功能
- 不具备【内置AI模型】（AI 模型由用户自行配置，请按照《生成式人工智能服务管理暂行办法》合规使用大模型）

**务必不要使用本工具进行任何违反中国法律的行为！！！**

---

Thanks to everyone on [LinuxDo](https://linux.do/) for their support!

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Mouseww/anything-analyzer&type=Date)](https://star-history.com/#Mouseww/anything-analyzer&Date)

## License

MIT
