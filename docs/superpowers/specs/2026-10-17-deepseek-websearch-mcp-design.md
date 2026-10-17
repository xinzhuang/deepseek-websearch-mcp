# deepseek-websearch-mcp 设计文档

- 日期：2026-10-17
- 状态：已与用户确认
- 上游 API 文档：
  - Search API：https://api-docs.deepseek.com/zh-cn/api/search
  - 使用指南：https://api-docs.deepseek.com/zh-cn/guides/search

## 1. 背景与目标

DeepSeek 新发布的网页搜索 API 由自研搜索引擎提供支持，包含两个端点，使用与 DeepSeek API 相同的 Bearer 鉴权：

| API | Endpoint | 说明 |
|---|---|---|
| Search | `POST https://api.deepseek.com/v1/tools/search` | 按 query 搜索网页，返回结构化结果 |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` | 抓取单个网页，返回 Markdown 正文 |

本项目实现一个 Node.js MCP server（TypeScript，stdio 传输），将这两个端点暴露为 MCP 工具。目标：

1. 支持主流安装方式：`npx` 一键运行、npm 全局安装、从 GitHub 源码运行
2. 认证信息全部通过环境变量注入，不落盘、不进代码
3. 测试通过后发布到 GitHub 仓库（不做 npm publish，本地 `npm pack` 验证打包产物）

### 非目标（YAGNI）

- 不做 HTTP/SSE 传输模式（仅 stdio）
- 不做 npm publish
- 不做请求缓存、结果落盘、遥测
- 不做服务端入参 zod 校验（MCP 客户端已按 inputSchema 校验；服务端只做格式化必需的最小防御）

## 2. 上游 API 规格（实现依据）

### 2.1 鉴权

请求头：`Authorization: Bearer <DeepSeek API Key>`、`Content-Type: application/json`。

### 2.2 Search 请求字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | 是 | - | 1~128 个 Unicode 字符，不能全为空白；支持 `site:`、`-site:`、`-`、`-"..."`、`"..."`、`lang:`、`after:`、`before:` |
| `count` | integer | 否 | 10 | 1~50 |
| `ori_question` | string\|null | 否 | - | 用户原始问题，1~128 字符，`null` 视为未提供 |
| `localization` | string | 否 | "" | 用于本地化的 IP 地址 |
| `need_content` | boolean | 否 | false | 为 false 时响应 `content` 恒为空字符串 |

### 2.3 Search 响应

`results[]`（无匹配时为空数组），每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rerank_score` | number | 0~3，≥1.5 为优质结果 |
| `title` | string | 标题 |
| `url` | string | 链接 |
| `snippet` | string | 短摘要 100~200 字符 |
| `summary` | string | 长摘要 600~800 字符，适合模型阅读 |
| `content` | string | 正文，`need_content=false` 或缺失时为空串 |
| `site_name` | string\|null | 站点名 |
| `site_icon` | string\|null | 站点图标 URL |
| `date` | string\|null | 发布时间，UTC RFC 3339 |
| `authority` | integer | 0~4（-1 未知），≥3 为极权威 |

### 2.4 Fetch 请求与响应

请求：`url`（string，必填，≤8192，必须含 host 的 HTTP/HTTPS URL，不能携带用户名或密码）。

响应：`{ "title": string, "content": string }`；`title` 缺失时为空字符串。

### 2.5 错误格式与状态码

OpenAI 兼容错误体：`{ error: { message, type, param, code } }`，`param` 恒为 `null`。

| HTTP | 语义 | 处理策略 |
|---|---|---|
| 400 | 请求头/体不合法 | 工具级错误，不重试 |
| 401 | Key 缺失或无效 | 工具级错误，不重试 |
| 402 | 余额不足 | 工具级错误，不重试，提示充值 |
| 403 | Fetch 被安全策略拒绝 | 工具级错误，不重试 |
| 404 | Fetch 无可用内容 | 工具级错误，不重试 |
| 408 | 读取请求体超时 | 可重试 |
| 413 | 请求体过大 | 工具级错误，不重试 |
| 429 | 超 QPS | 可重试 |
| 500/504 | 服务端/下游错误 | 可重试 |

官方指引：408/429/5xx 等待后重试；402 先充值；其余 4xx 不修改请求勿重试。

### 2.6 计费与限速

- Search / Fetch 各按成功请求计费：5 元 / 1000 次；只有 HTTP 200 且产生结果才计费
- QPS：Search、Fetch 各 5（账号级，与 Key 无关）

## 3. 架构

```
┌─────────────┐   stdio (JSON-RPC 2.0)   ┌────────────────────────────┐
│ MCP Client  │ ◄──────────────────────► │ deepseek-websearch-mcp     │
└─────────────┘                          │  src/index.ts   入口        │
                                         │  src/tools.ts   工具层      │
                                         │  src/client.ts  HTTP 客户端 │
                                         └─────────────┬──────────────┘
                                                       ▼
                                              api.deepseek.com
```

- 技术栈：TypeScript + 官方 `@modelcontextprotocol/sdk`（`McpServer` + `StdioServerTransport`）+ Node 内置 `fetch`，`tsc` 编译。运行时依赖仅 SDK 一个。
- 传输：仅 stdio。诊断信息一律走 stderr；stdout 只承载 MCP 协议。

### 组件职责

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/index.ts` | 读环境变量并校验；创建 McpServer；用 JSON Schema 注册工具；连接 StdioServerTransport | tools、client |
| `src/tools.ts` | 两个工具的 inputSchema + handler；入参→client 调用→Markdown 格式化；错误映射为 isError 结果 | client |
| `src/client.ts` | `search()` / `fetchUrl()`；Bearer 头；60s 超时；错误分类；408/429/5xx 退避重试 | Node fetch |

## 4. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | - | DeepSeek API Key；缺失时 stderr 报错并以 exit code 1 退出 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | 覆盖 API 基址（测试注入 stub、自建网关） |
| `DEEPSEEK_TIMEOUT_MS` | 否 | `60000` | 单次 HTTP 请求超时（毫秒） |

## 5. 工具定义

### 5.1 `web_search`

- **description**：使用 DeepSeek 搜索引擎搜索网页，返回带排序分数、权威性、发布时间的结构化结果；支持 `site:` / `-site:` / `"精确短语"` / `lang:zh,en` / `after:2025` / `before:2026` / `-排除词` 搜索语法。

inputSchema（JSON Schema）：

| 属性 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | minLength 1, maxLength 128 |
| `count` | integer | 否 | 1~50，默认 10 |
| `ori_question` | string | 否 | 1~128 字符 |
| `localization` | string | 否 | IP 地址 |
| `need_content` | boolean | 否 | 默认 false |

**输出格式（Markdown，按 rerank_score 已排序列出）：**

```markdown
共 N 条结果：

### 1. 标题
- URL: https://…
- 站点: Example News ｜ 发布: 2026-06-01 ｜ 权威性: 3/4 ｜ 相关性: 2.4
摘要（summary）文本……

[need_content=true 时]
正文：
……
```

- `date` 为 null 时省略发布字段；`authority=-1` 显示「未知」
- 无结果时返回「搜索完成，但没有匹配的结果。可尝试调整 query 或放宽过滤语法。」

### 5.2 `web_fetch`

- **description**：抓取单个网页，返回页面标题与 Markdown 正文。适用于读取 web_search 结果中某个 URL 的完整内容。

| 属性 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `url` | string | 是 | maxLength 8192，HTTP/HTTPS 且含 host，不允许 userinfo |

**输出格式：**

```markdown
# {title}

{content}
```

- 404（不可抓取）与 403（被拦截）返回语义化 isError 消息（含原因与建议），而非进程崩溃

### 5.3 本地防御性校验（最小集合）

服务端仅做：`query` 非空白字符串；`url` 可被 `new URL()` 解析、协议为 http/https、无 username/password、host 非空。目的：在 API 400 之前给出更友好的本地错误消息。其余交给 API 校验。

## 6. 错误处理

**两层语义：**

1. **工具级错误**（tool result `isError: true`，进程不退出）：预期内业务失败——401/402/400/403/404/413、本地 URL/query 校验失败、空结果提示。消息面向模型可读，说明原因与下一步建议。
2. **协议级错误**（MCP 协议错误响应）：工具不存在等协议层异常，由 SDK 处理。

**重试策略**：仅对 408/429/500/504 重试，最多 2 次，指数退避 1s → 2s。重试期间发生非可重试错误则立即返回该错误。402 及其余 4xx 永不重试。

**启动检查**：`DEEPSEEK_API_KEY` 缺失或空白 → stderr 输出 `deepseek-websearch-mcp: DEEPSEEK_API_KEY environment variable is required` → `process.exit(1)`。

**超时**：单次请求 60s（可用 `DEEPSEEK_TIMEOUT_MS` 调整），超时按可重试错误处理（计入同一重试预算）。

## 7. 测试策略

vitest，四层：

| 层 | 范围 | 方式 |
|---|---|---|
| 1. client 单元 | 鉴权头、请求体序列化、错误分类、重试次数与退避、超时 | `vi.stubGlobal('fetch', …)` stub 注入 |
| 2. tools 单元 | Markdown 格式化（含 null 字段省略）、空结果文案、isError 映射、本地校验 | stub client |
| 3. stdio 端到端 | spawn `tsx src/index.ts`（无需先 build），真实 JSON-RPC initialize 握手 → tools/list 断言两个工具 schema → tools/call（`DEEPSEEK_BASE_URL` 指向本地 stub server） | Node http 本地 stub |
| 4. 可选集成 | 真实 API 冒烟：真实搜索一次 + 抓取 example.com | `describe.skipIf(!process.env.DEEPSEEK_API_KEY)` |

质量门禁：`tsc --noEmit` 类型检查 + 全量 vitest 通过后才算完成。

## 8. 发布与安装配置

package.json 关键字段：

```jsonc
{
  "name": "deepseek-websearch-mcp",
  "type": "module",
  "bin": { "deepseek-websearch-mcp": "dist/index.js" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20" },
  "repository": "github:xinzhuang/deepseek-websearch-mcp"
}
```

- `dist/index.js` 头部带 `#!/usr/bin/env node`
- 三种主流安装/使用方式（写入 README）：
  1. 本仓库阶段（未 publish 到 npm）：`npx -y github:xinzhuang/deepseek-websearch-mcp` 直接从 GitHub 运行；以及 `npm install -g .` 本地全局安装
  2. 未来 publish 后：`npx -y deepseek-websearch-mcp`（零安装）
  3. 客户端配置片段：Claude Code（`claude mcp add`）、Cursor、VS Code(mcp.json)、通用 JSON（command + env）
- 发布流程：`npm run build && npm pack` 验证 tarball 内容只含 `dist/` 与 README，推送到 GitHub 打 tag（`v0.1.0`）。npm publish 不在本次范围。

## 9. 项目结构

```
deepseek-websearch-mcp/
├── src/
│   ├── index.ts        # 入口
│   ├── tools.ts        # 工具 schema + handler
│   └── client.ts       # DeepSeek HTTP 客户端
├── test/
│   ├── client.test.ts
│   ├── tools.test.ts
│   ├── stdio.e2e.test.ts
│   └── integration.test.ts
├── dist/               # tsc 产物（gitignore）
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── LICENSE             # 已有 MIT
└── .gitignore          # 已有，补充 dist/
```
