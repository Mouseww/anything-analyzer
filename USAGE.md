# Anything Analyzer — 使用说明

> **版本：v3.2.0** | [English](#english-guide)

---

## 目录

- [界面概览](#界面概览)
- [快速上手](#快速上手)
- [会话管理](#会话管理)
- [浏览器视图](#浏览器视图)
- [检查器视图](#检查器视图)
- [AI 报告视图](#ai-报告视图)
- [MITM 代理抓包](#mitm-代理抓包)
- [设置](#设置)
- [快捷操作](#快捷操作)
- [常见问题](#常见问题)

---

## 界面概览

Anything Analyzer 的界面分为以下区域：

```
┌─────────────────────────────────────────────────────────┐
│  标题栏   [Browser] [Inspector] [Report]   🌐 🌙  ─ □ ✕ │
├────────┬────────────────────────────────────────────────┤
│        │                                                │
│ 会话列表 │              主视图区域                         │
│        │    （浏览器 / 检查器 / AI 报告）                  │
│        │                                                │
│  [⚙]   │                                                │
├────────┴────────────────────────────────────────────────┤
│  状态栏：会话状态 · 请求数 · Hook 数 · LLM 模型           │
└─────────────────────────────────────────────────────────┘
```

### 标题栏

- **导航标签**：切换 Browser（浏览器）、Inspector（检查器）、Report（AI 报告）三个视图
- **语言切换**：点击 🌐 按钮在中文/English 之间切换
- **主题切换**：点击 🌙/☀ 按钮在深色/浅色主题之间切换
- **窗口控制**：最小化、最大化/还原、关闭

### 侧边栏

- 会话列表：管理所有抓包会话
- 设置入口：左下角齿轮图标

### 状态栏

底部显示当前会话状态、请求计数、Hook 计数，分析完成后还会显示 LLM 模型名称和 token 消耗。

---

## 快速上手

### 第一步：配置 LLM

1. 点击左下角 ⚙ 打开设置
2. 进入「LLM」选项卡
3. 选择 Provider（OpenAI / Anthropic / 自定义兼容 API）
4. 填入 API Base URL 和 API Key
5. 选择模型（如 `gpt-4o`、`claude-sonnet-4-20250514`）
6. 点击保存

> 支持任何兼容 OpenAI Chat Completions API 的服务（如 DeepSeek、通义千问、本地 Ollama 等）。

### 第二步：新建会话

1. 在左侧会话列表点击「+ 新建会话」
2. 输入会话名称（如「淘宝登录流程」）
3. 输入目标 URL（如 `https://taobao.com`）
4. 点击「创建」

### 第三步：抓包

1. 内嵌浏览器会自动加载目标 URL
2. 在浏览器地址栏右侧点击「● 开始」按钮
3. 在浏览器中正常操作网站（登录、浏览、提交表单等）
4. 操作完成后点击「■ 停止」

### 第四步：分析

1. 切换到 Inspector 视图查看抓到的请求
2. 在底部分析栏选择分析模式（默认「自动检测」）
3. 点击「✦ 分析」按钮
4. 等待 AI 生成分析报告（支持实时流式输出）

---

## 会话管理

### 创建会话

每个会话代表一次完整的抓包任务，包含：
- 所有捕获的 HTTP 请求/响应
- JS Hook 记录（加密调用、fetch/XHR 拦截等）
- 存储快照（Cookie、localStorage、sessionStorage）
- AI 分析报告

### 删除会话

右键或悬停会话项，点击删除按钮。删除会话将清除该会话的所有数据，不可恢复。

### 会话状态

| 状态 | 含义 |
|------|------|
| 运行中 | 正在捕获请求 |
| 已暂停 | 暂停捕获，可恢复 |
| 已停止 | 停止捕获，可开始分析 |

---

## 浏览器视图

### 多标签页

- 支持多个浏览器标签页，点击 `+` 创建新标签
- OAuth 登录弹窗会自动捕获为内部标签页
- 标签页显示当前页面标题

### 地址栏

- 输入 URL 回车导航
- 左侧导航按钮：后退、前进、刷新
- 右侧抓包控制按钮：
  - **● 开始**：开始捕获请求
  - **⏸ 暂停**：暂停捕获（保持会话打开）
  - **▶ 恢复**：恢复已暂停的捕获
  - **■ 停止**：停止捕获并结束会话

### 抓包控制

- **暂停 / 恢复**：临时停止捕获而不结束会话，适合在操作过程中跳过不需要的请求
- **停止**：完全结束抓包，之后可以进行 AI 分析

---

## 检查器视图

检查器是数据查看和分析的核心视图，包含三个子标签页：

### Requests（请求列表）

显示所有捕获到的 HTTP 请求，包含以下列：

| 列名 | 说明 |
|------|------|
| # | 请求序号，标识捕获顺序 |
| Method | HTTP 方法（GET/POST/PUT/DELETE 等），颜色区分 |
| Domain | 请求域名，支持筛选 |
| Path | 请求路径 + 查询参数 |
| Status | HTTP 状态码，颜色区分 |
| Time | 请求耗时（毫秒） |
| Source | 请求来源：CDP（浏览器）或 Proxy（MITM 代理） |

**功能操作：**

- **搜索**：顶部搜索框按 URL 过滤
- **列筛选**：点击列头的漏斗图标，按 Method、Domain、Source 筛选
- **排序**：点击 Status、Time 列头排序
- **选中查看详情**：点击任意请求行，右侧面板显示完整请求/响应详情
- **多选分析**：勾选多条请求，可以只分析选中的请求
- **Shift+Click 批量选中**：先点击一条，按住 Shift 点击另一条，两条之间的所有请求都会被选中
- **全选/取消**：点击表头复选框全选或取消全选

### 请求详情面板

点击请求行后，右侧面板显示：

- **Request Headers**：完整请求头
- **Request Body**：请求体（JSON 自动格式化）
- **Response Headers**：完整响应头
- **Response Body**：响应体（JSON 自动格式化，代码高亮）
- **关联 Hooks**：与该请求关联的 JS Hook 记录

### Hooks（JS Hook 记录）

显示 JS Hook 注入捕获的调用记录：

- **fetch / XHR**：前端发出的 HTTP 请求（补充 CDP 未捕获的信息）
- **crypto.subtle**：浏览器原生加密 API 调用（encrypt/decrypt/sign/digest 等）
- **CryptoJS**：CryptoJS 库的加密调用
- **SM2/SM3/SM4**：国密算法调用
- **Cookie 设置**：document.cookie 写操作

每条记录包含：函数名、参数、返回值、调用栈。

### Storage（存储快照）

定时采集的浏览器存储数据：

- **Cookies**：按域名分组的 Cookie 数据
- **localStorage**：本地存储键值对
- **sessionStorage**：会话存储键值对

### 底部分析栏

| 控件 | 说明 |
|------|------|
| 分析模式下拉框 | 选择分析目的：自动检测 / 自定义模板 |
| ✦ 分析 | 对所有请求进行 AI 分析 |
| 分析选中 (N) | 仅分析勾选的请求（出现条件：至少选中 1 条） |
| 已选 N / 共 M 请求 | 当前选中和总数统计 |
| ⬇ 导出 | 导出请求数据为 JSON 文件 |

---

## AI 报告视图

### 分析流程

1. **Phase 1 — 智能过滤**（请求数 >= 20 时自动触发）
   - AI 评估每条请求的相关性
   - 过滤掉静态资源、跟踪请求等噪声
   - 选出最有分析价值的请求子集

2. **Phase 2 — 深度分析**
   - 基于过滤后的请求集进行全面分析
   - AI 可通过内置工具按需查看完整请求详情
   - 生成结构化的 Markdown 报告

### 分析模式

| 模式 | 适用场景 |
|------|---------|
| 自动识别 | AI 自动判断场景，生成通用分析报告 |
| API 逆向 | API 端点文档 + 鉴权流程 + Python 复现代码 |
| 安全审计 | Token 泄露、CSRF/XSS 风险、敏感数据暴露 |
| 性能分析 | 请求时序、冗余请求、资源加载、缓存策略 |
| JS 加密逆向 | 加密算法识别 + 流程还原 + Python 实现 |
| 自定义模板 | 使用设置中配置的自定义 Prompt 模板 |

### 停止分析

分析过程中可随时点击「停止分析」按钮中断，不需要等待超时。

### 报告界面

报告生成后，界面分为两部分：

**左侧主区域：**
- 报告工具栏：模型名称、导出、重新分析
- 报告元数据：模型、时间、请求数量
- Markdown 渲染的报告内容（代码高亮）
- 多轮追问对话记录

**右侧上下文面板：**
- 当前会话信息
- 请求和 Hook 统计
- 关键 API 端点列表
- Hook 类型分布
- LLM 模型和 token 消耗

### 多轮追问

报告生成后支持继续追问：

- **快捷问题按钮**：
  - 生成 Python 复现代码
  - 详解加密/签名流程
  - 分析潜在安全风险
  - 列出所有 API 参数和响应结构

- **自由追问**：在输入框中输入任何问题，Enter 发送

- **上下文感知**：追问时 AI 自动携带捕获数据摘要，并可通过内置工具查看任意请求的完整详情（请求头/体、响应头/体）

### 导出报告

点击「⬇ 导出 .md」将报告（含追问对话）保存为 Markdown 文件。

---

## MITM 代理抓包

除了内嵌浏览器，Anything Analyzer 还内置了 MITM（中间人）HTTPS 代理，可以捕获任何应用的 HTTP/HTTPS 流量。

### 初始设置

1. 打开设置 → MITM 代理
2. 点击「安装 CA 证书」（需管理员权限）
3. 启用代理（默认端口 `8888`）

### 抓取不同应用

**终端命令：**
```bash
# curl
curl -x http://127.0.0.1:8888 https://api.example.com/data

# wget
https_proxy=http://127.0.0.1:8888 wget https://api.example.com/data

# httpie
http --proxy=https:http://127.0.0.1:8888 https://api.example.com/data
```

**Python 脚本：**
```python
import requests

proxies = {
    "http": "http://127.0.0.1:8888",
    "https": "http://127.0.0.1:8888"
}
resp = requests.get("https://api.example.com/data", proxies=proxies)
```

**Node.js：**
```bash
HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 node app.js
```

**桌面应用（系统全局代理）：**
1. 在设置中开启「设为系统代理」
2. 所有走系统代理的应用流量将自动被捕获

**手机 / 平板：**
1. 确保手机和电脑在同一 Wi-Fi 下
2. 手机 Wi-Fi 设置 → HTTP 代理 → 手动
3. 服务器填入电脑 IP，端口填 `8888`
4. 用手机浏览器访问代理地址下载并安装 CA 证书
5. 新建会话 → 开始抓包 → 手机端操作 App

### CA 证书说明

| 项目 | 说明 |
|------|------|
| 存储位置 | Windows: `%APPDATA%/anything-analyzer/certs/` |
|          | macOS: `~/Library/Application Support/anything-analyzer/certs/` |
| 根 CA 有效期 | 10 年 |
| 子证书有效期 | 825 天（符合 Apple 要求） |
| 证书操作 | 安装 / 卸载 / 重新生成 / 导出 |
| 安全说明 | MITM 代理为只读捕获，不修改请求/响应内容 |
| 限制 | 单个 body 上限 1MB，二进制内容自动跳过，WebSocket 隧道转发不解密 |

---

## 设置

点击左下角齿轮图标打开设置面板，包含以下选项卡：

### 通用

- 语言选择：中文 / English
- 主题选择：深色 / 浅色
- 自动更新检查

### LLM

| 配置项 | 说明 |
|--------|------|
| Provider | OpenAI / Anthropic / 自定义 |
| API Type | Chat Completions / Responses API（OpenAI） |
| Base URL | API 地址（如 `https://api.openai.com/v1`） |
| API Key | 你的 API 密钥 |
| Model | 模型名称（如 `gpt-4o`、`claude-sonnet-4-20250514`） |
| Max Tokens | 最大输出 token 数 |

### Prompt 模板

管理 AI 分析的 Prompt 模板：
- 内置多种模板（API 逆向、安全审计、性能分析、加密逆向）
- 支持自定义模板：编辑 System Prompt 和分析要求
- 可修改内置模板，也可重置为默认

### MCP 客户端

配置外部 MCP Server，扩展 AI 分析能力：
- 支持 stdio 和 StreamableHTTP 两种传输方式
- AI 分析时可自动调用 MCP 工具

#### 示例：使用 Parallel 搜索公开协议文档

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) 提供网页搜索（`web_search`）和网页内容提取（`web_fetch`），可用于查找 HTTP 规范、公开 API 文档等参考资料。匿名搜索默认使用 Fast 模式，无需 Parallel 账号或 API Key；免费服务有使用限额。

1. 打开「设置 → 通用 → 管理 MCP 服务器」，点击「添加服务器」。
2. 名称填写 `Parallel Search`，保持「启用」开启，传输类型选择「远程服务 (HTTP)」。
3. 在「配置 (JSON)」中粘贴以下内容，然后点击「保存」：

   ```json
   {
     "url": "https://search.parallel.ai/mcp",
     "headers": {
       "User-Agent": "anything-analyzer"
     }
   }
   ```

这是单个服务器的配置，不需要外层 `mcpServers`。应用会在下一次开始分析时连接已启用的服务器，模型可根据分析要求选择调用工具；仍需先配置支持工具调用的 LLM。

例如，在「管理提示词模板」中为自定义模板的分析要求加入以下内容，保存后在分析模式中选择该模板：

> 使用 Parallel 的 web_search 查找 MDN 关于 HTTP 429 和 Retry-After 的公开文档，再用 web_fetch 读取相关页面。结合捕获到的状态码和响应头解释重试行为，并给出参考链接。搜索和抓取参数仅使用公开协议名称和公开文档 URL，不要发送捕获的 Cookie、Authorization、请求体或私有 URL。

外部工具的调用参数会发送给 Parallel。仅对允许分享的内容使用此功能；网页资料作为参考，实际抓包数据仍需单独核对。不再需要时，可在同一管理窗口删除该服务器以断开连接。

### MCP 服务端

将 Anything Analyzer 的抓包和分析能力暴露为 MCP 工具：
- 可被 Claude Desktop、Cursor 等 AI 工具直接调用
- 配置监听端口

### 代理

配置 Anything Analyzer 自身的出站代理：
- 支持 HTTP / HTTPS / SOCKS5
- 用于内嵌浏览器和 AI API 请求

### MITM 代理

- 启用/禁用 MITM 代理
- 配置监听端口
- CA 证书管理（安装/卸载/重新生成/导出）
- 系统代理开关

---

## 快捷操作

| 操作 | 方法 |
|------|------|
| 全选请求 | 点击表头复选框 |
| 范围选中 | 先点击一条，Shift+Click 另一条 |
| 搜索请求 | 检查器顶部搜索框输入 URL 关键字 |
| 筛选方法 | 点击 Method 列头漏斗图标 |
| 筛选域名 | 点击 Domain 列头漏斗图标（支持搜索） |
| 查看详情 | 点击请求行 |
| 导出报告 | 报告视图工具栏「导出 .md」 |
| 导出请求 | 检查器底栏「导出」按钮 |
| 切换语言 | 标题栏 🌐 按钮 |
| 切换主题 | 标题栏 🌙/☀ 按钮 |

---

## 常见问题

### AI 分析失败

| 错误提示 | 解决方案 |
|---------|---------|
| DNS 解析失败 | 检查 API 地址拼写是否正确 |
| 连接被拒绝 | 确认 API 服务已启动（本地中转时常见） |
| 网络请求失败 | 检查网络连接，可能需要代理/VPN |
| 连接超时 | API 服务响应慢，检查网络或更换节点 |
| SSL 证书错误 | 检查 API 地址是否正确，代理是否干扰 |
| LLM provider not configured | 先在设置中配置 LLM |

### MITM 代理无法抓到 HTTPS

1. 确认已安装 CA 证书
2. 确认应用使用系统代理（部分应用需手动配置）
3. 证书固定（Certificate Pinning）的应用无法被 MITM 代理捕获

### 请求列表为空

1. 确认已点击「开始」按钮
2. 确认在正确的会话下操作
3. 内嵌浏览器操作时确认页面已加载
4. MITM 代理模式确认外部应用已配置代理

### 追问回答不准确

- AI 追问时已自动携带请求摘要上下文
- 追问时 AI 可以通过工具查看任意请求的完整详情
- 建议追问时指明具体的请求序号（如「请查看 #5 请求的响应体」）

---

<a name="english-guide"></a>

## English Guide

### Quick Start

1. **Configure LLM**: Settings → LLM → Enter API Key (supports OpenAI / Anthropic / any compatible API)
2. **Create Session**: Enter a session name and target URL
3. **Capture Traffic**: Click "Start" in the browser address bar, operate the website
4. **Analyze**: Switch to Inspector view → Click "Analyze"

### Interface

The app has three main views:

- **Browser**: Embedded browser with capture controls and multi-tab support
- **Inspector**: View captured requests, JS hooks, and storage data
- **Report**: AI analysis reports with follow-up chat

### Key Features

- **Language**: Toggle between Chinese and English via the globe icon in the title bar
- **Theme**: Toggle between Dark and Light mode via the theme icon
- **Shift+Click**: Select a range of requests for batch analysis
- **Follow-up Chat**: Ask follow-up questions after analysis — AI has access to all captured data and can inspect any request in detail
- **Stop Analysis**: Cancel an in-progress analysis at any time
- **MITM Proxy**: Capture traffic from any application (terminal, scripts, mobile apps)
- **Export**: Export requests as JSON or reports as Markdown

### Settings

- **LLM**: Configure AI provider, API key, model, and max tokens
- **Prompt Templates**: Customize analysis prompts
- **MCP Client**: Connect external MCP servers
- **MCP Server**: Expose analyzer as MCP tools
- **Proxy**: Configure outbound proxy
- **MITM Proxy**: Enable HTTPS interception proxy with CA certificate management

### Example: look up public protocol references with Parallel

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides web search (`web_search`) and page extraction (`web_fetch`) for references such as HTTP specifications and public API documentation. Anonymous search uses Fast mode by default, with no Parallel account or API key required. Free usage is subject to limits.

1. Open Settings → General (`通用`) → Manage MCP Servers (`管理 MCP 服务器`), then click Add Server (`添加服务器`).
2. Name it `Parallel Search`, leave Enabled (`启用`) on, and select Remote Service (`远程服务 (HTTP)`).
3. Paste the following into Configuration (`配置 (JSON)`) and click Save (`保存`):

   ```json
   {
     "url": "https://search.parallel.ai/mcp",
     "headers": {
       "User-Agent": "anything-analyzer"
     }
   }
   ```

This is the configuration for one server; do not wrap it in `mcpServers`. Enabled servers connect when you next start an analysis. Your model can choose tools according to the analysis requirements, so configure a tool-capable LLM first.

For example, add this analysis requirement to a custom template in Manage Prompt Templates (`管理提示词模板`), save it, and select that template as the analysis mode:

> Use Parallel's web_search to find public MDN documentation for HTTP 429 and Retry-After, then read relevant pages with web_fetch. Explain retry behavior using the captured status codes and response headers, and cite the reference URLs. Use only public protocol names and public documentation URLs in search and fetch arguments. Do not send captured cookies, Authorization headers, request bodies, or private URLs.

External tool arguments are sent to Parallel. Use this only with information you are allowed to share, and compare reference material against the actual capture. To disconnect the server when you no longer need it, delete its entry in the same management window.

---

*Anything Analyzer v3.2.0 — Universal Web Protocol Analyzer*
