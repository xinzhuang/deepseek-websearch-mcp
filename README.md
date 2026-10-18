# deepseek-websearch-mcp

基于 [DeepSeek 网页搜索与抓取 API](https://api-docs.deepseek.com/zh-cn/guides/search) 的 MCP server（stdio 传输），为支持 MCP 的 AI 客户端（Claude Code、Cursor、VS Code 等）提供两个工具：

- **web_search** —— DeepSeek 自研搜索引擎，返回带相关性分数、权威性、发布时间的结构化结果，支持 `site:`、`lang:`、`after:` 等搜索语法
- **web_fetch** —— 抓取单个网页，返回 Markdown 正文

## 前置要求

- Node.js ≥ 20
- [DeepSeek API Key](https://platform.deepseek.com/)（Search/Fetch 按成功请求计费：5 元/千次）

## 安装与配置

认证信息通过环境变量 `DEEPSEEK_API_KEY` 注入。

| 环境变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | - | DeepSeek API Key，缺失时启动即退出 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | API 基址（自建网关/调试用） |
| `DEEPSEEK_TIMEOUT_MS` | 否 | `60000` | 单次 HTTP 请求超时（毫秒） |

### 方式一：npx 直接运行（推荐）

```bash
npx -y @frankzhang-ai/deepseek-websearch-mcp
```

### 方式二：全局安装

```bash
npm install -g @frankzhang-ai/deepseek-websearch-mcp
deepseek-websearch-mcp
```

### 方式二备选：从 GitHub 安装（不经 npm registry）

```bash
npx -y github:xinzhuang/deepseek-websearch-mcp
```

> 注意：npm v11 对 `npm install -g github:...` 存在已知缺陷（安装后留下指向已清理临时目录的死链，见 [npm/cli#1390](https://github.com/npm/cli/issues/1390) 一类问题），如遇 `command not found` 请改用上方 registry 安装。

### 方式三：客户端配置

**Claude Code**

```bash
claude mcp add deepseek-websearch -s user -e DEEPSEEK_API_KEY=sk-你的key -- npx -y @frankzhang-ai/deepseek-websearch-mcp
```

**Cursor / 通用 JSON（`mcp.json`）**

```json
{
  "mcpServers": {
    "deepseek-websearch": {
      "command": "npx",
      "args": ["-y", "@frankzhang-ai/deepseek-websearch-mcp"],
      "env": { "DEEPSEEK_API_KEY": "sk-你的key" }
    }
  }
}
```

**VS Code（`mcp.json`）**

```json
{
  "servers": {
    "deepseek-websearch": {
      "command": "npx",
      "args": ["-y", "@frankzhang-ai/deepseek-websearch-mcp"],
      "env": { "DEEPSEEK_API_KEY": "sk-你的key" }
    }
  }
}
```

## 工具说明

### web_search

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 1~128 字符；支持 `site:`、`-site:`、`"精确短语"`、`lang:zh,en`、`after:2025`、`before:2026`、`-排除词` |
| `count` | integer | 否 | 返回条数 1~50，默认 10 |
| `ori_question` | string | 否 | 触发搜索的用户原始问题 |
| `localization` | string | 否 | 本地化 IP |
| `need_content` | boolean | 否 | 返回网页正文，默认 false（正文较长，按需开启） |

### web_fetch

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | ≤8192 字符的 http/https URL，不允许携带用户名密码 |

## 错误处理

- 408/429/5xx 自动指数退避重试（最多 2 次）；402 及其余 4xx 不重试
- 预期内错误以 `isError` 工具结果返回模型可读消息；`DEEPSEEK_API_KEY` 缺失时启动即报错退出
- 限速：Search/Fetch 各 5 QPS（账号级）

## 开发

```bash
npm install
npm run typecheck   # 类型检查
npm test            # 单元 + stdio 端到端（全 mock，无需 Key）
DEEPSEEK_API_KEY=sk-xxx npm test   # 额外运行真实 API 集成测试（会产生计费调用）
npm run build       # tsc 构建到 dist/
```

## License

[MIT](LICENSE)
