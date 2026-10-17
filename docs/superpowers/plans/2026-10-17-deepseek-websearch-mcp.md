# deepseek-websearch-mcp 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek 网页搜索/抓取 API（`/v1/tools/search`、`/v1/tools/fetch`）封装为 stdio 传输的 Node.js MCP server，四层测试通过后推送到 GitHub 并打 tag。

**Architecture:** 三个源文件单一职责分层——`index.ts`（入口+MCP wiring）、`tools.ts`（工具 schema+校验+格式化）、`client.ts`（HTTP 客户端+重试）。MCP 协议层使用官方 SDK 低层 `Server` 类。

**Tech Stack:** TypeScript 5（NodeNext ESM）、`@modelcontextprotocol/sdk` ^1.32.1（唯一运行时依赖）、Node 内置 fetch（Node ≥20）、vitest、tsx（dev）

**规格偏差说明（已验证，需知悉）：** 规格原文写「SDK `registerTool` 支持原生 JSON Schema」——经对 npm 稳定版 1.32.1 的 `.d.ts` 实际检查，`registerTool.inputSchema` 仅接受 zod（`fromJsonSchema` 只在 2.x alpha）。因规格非目标明确排除 zod，本计划改用 SDK 低层 `Server` + `setRequestHandler` 原生 JSON Schema。架构与文件划分不变。

**规格：** `docs/superpowers/specs/2026-10-17-deepseek-websearch-mcp-design.md`

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore`（确认含 `node_modules/`、`dist/`）

- [ ] **Step 1: 确认 Node 版本 ≥20**

Run: `node --version`
Expected: `v20.x` 或更高

- [ ] **Step 2: 检查并补充 .gitignore**

Run: `grep -E "node_modules|dist" .gitignore`
若缺失则在 `.gitignore` 末尾追加：

```
node_modules/
dist/
*.tgz
```

- [ ] **Step 3: 写入 package.json**

```json
{
  "name": "deepseek-websearch-mcp",
  "version": "0.1.0",
  "description": "MCP server exposing DeepSeek web search & fetch APIs (web_search / web_fetch) over stdio",
  "type": "module",
  "license": "MIT",
  "bin": {
    "deepseek-websearch-mcp": "dist/index.js"
  },
  "files": [
    "dist",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "repository": "github:xinzhuang/deepseek-websearch-mcp",
  "keywords": [
    "mcp",
    "deepseek",
    "web-search",
    "search",
    "model-context-protocol"
  ],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepare": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: 写入 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: 写入 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 6: 安装依赖**

Run: `npm install`
Expected: 无 error，`node_modules/` 生成

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: 项目脚手架（TypeScript ESM + MCP SDK + vitest）"
```

---

### Task 2: client.ts —— 请求构造与响应解析（TDD）

**Files:**
- Create: `src/client.ts`
- Test: `test/client.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/client.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekClient } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const noopSleep = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeekClient.search', () => {
  it('以 Bearer 头 POST {baseUrl}/v1/tools/search 并解析 results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        results: [
          {
            rerank_score: 2.4,
            title: 'T',
            url: 'https://e.com',
            snippet: 's',
            summary: 'sum',
            content: '',
            site_name: null,
            site_icon: null,
            date: null,
            authority: 3,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'sk-test', sleep: noopSleep });
    const res = await client.search({ query: 'DeepSeek', count: 5 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ query: 'DeepSeek', count: 5 });
    expect(res.results[0].title).toBe('T');
  });

  it('未提供的可选字段不出现在请求体；baseUrl 尾部斜杠被归一化', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/', sleep: noopSleep });
    await client.search({ query: 'x' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/tools/search');
    expect(JSON.parse(init.body)).toEqual({ query: 'x' });
  });
});

describe('DeepSeekClient.fetchUrl', () => {
  it('POST /v1/tools/fetch 并解析 title/content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { title: 'Example', content: '# Hello' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'k', sleep: noopSleep });
    const page = await client.fetchUrl('https://example.com/a');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com/a' });
    expect(page).toEqual({ title: 'Example', content: '# Hello' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL——无法解析 `../src/client.js`（文件不存在）

- [ ] **Step 3: 实现 src/client.ts**

```ts
/** DeepSeek Search/Fetch API 的结果条目 */
export interface SearchResult {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface FetchResponse {
  title: string;
  content: string;
}

export interface SearchParams {
  query: string;
  count?: number;
  ori_question?: string;
  localization?: string;
  need_content?: boolean;
}

/** 上游返回的非 2xx 状态；retryable 遵循官方指引：408/429/5xx 可重试 */
export class DeepSeekApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekApiError';
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** 本地参数校验失败（在请求发出前拦截） */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入用；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60_000;
/** 首发尝试 + 最多 2 次重试 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];

/** DeepSeek Search/Fetch HTTP 客户端（Bearer 鉴权、超时、可重试错误退避重试） */
export class DeepSeekClient {
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DeepSeekClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    return (await this.post('/v1/tools/search', params)) as SearchResponse;
  }

  async fetchUrl(url: string): Promise<FetchResponse> {
    return (await this.post('/v1/tools/fetch', { url })) as FetchResponse;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: DeepSeekApiError | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.postOnce(path, body);
      } catch (err) {
        if (!(err instanceof DeepSeekApiError) || !err.retryable) throw err;
        lastError = err;
        if (attempt < MAX_ATTEMPTS - 1) await this.sleep(BACKOFF_MS[attempt]);
      }
    }
    throw lastError;
  }

  private async postOnce(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new DeepSeekApiError(res.status, await extractErrorMessage(res));
      return await res.json();
    } catch (err) {
      if (err instanceof DeepSeekApiError) throw err;
      if (controller.signal.aborted) throw new DeepSeekApiError(408, '请求超时');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/client.test.ts`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: DeepSeek HTTP 客户端（Bearer 鉴权/超时/错误分类）"
```

---

### Task 3: client.ts —— 错误重试与超时（TDD）

**Files:**
- Modify: `test/client.test.ts`（追加测试，实现已在 Task 2 一次到位，本任务验证行为）

- [ ] **Step 1: 追加失败测试**

在 `test/client.test.ts` 末尾追加（顶部 import 增加 `DeepSeekApiError`）：

```ts
import { DeepSeekApiError, DeepSeekClient } from '../src/client.js';
```

```ts
describe('DeepSeekClient 重试与超时', () => {
  it('429 时按 1s 退避重试一次后成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, {
          error: { message: 'rate limited', type: 'rate_limit_error', param: null, code: null },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const sleeps: number[] = [];
    const client = new DeepSeekClient({
      apiKey: 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.search({ query: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
    expect(res.results).toEqual([]);
  });

  it('连续 5xx 耗尽 3 次尝试后抛出，退避序列为 1s、2s', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(500, {
        error: { message: 'internal error', type: 'server_error', param: null, code: null },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const sleeps: number[] = [];
    const client = new DeepSeekClient({
      apiKey: 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.search({ query: 'x' })).rejects.toMatchObject({
      name: 'DeepSeekApiError',
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('402 余额不足不重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(402, {
          error: { message: 'insufficient balance', type: 'insufficient_balance', param: null, code: null },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const sleeps: number[] = [];
    const client = new DeepSeekClient({
      apiKey: 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.search({ query: 'x' })).rejects.toMatchObject({ status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('400 提取 OpenAI 兼容错误体的 message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: {
          message: "'count' must be between 1 and 50",
          type: 'invalid_request_error',
          param: null,
          code: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'k', sleep: noopSleep });
    const err = await client.search({ query: 'x', count: 99 }).catch((e) => e);

    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("'count' must be between 1 and 50");
    expect(err.retryable).toBe(false);
  });

  it('请求超时映射为可重试的 408 并走同一重试预算', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const sleeps: number[] = [];
    const client = new DeepSeekClient({
      apiKey: 'k',
      timeoutMs: 50,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.search({ query: 'x' })).rejects.toMatchObject({
      name: 'DeepSeekApiError',
      status: 408,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });
});
```

- [ ] **Step 2: 运行确认通过（实现已在 Task 2 覆盖）**

Run: `npx vitest run test/client.test.ts`
Expected: PASS（9 个测试全绿）。若有红，修复 `src/client.ts` 至全绿。

- [ ] **Step 3: Commit**

```bash
git add test/client.test.ts
git commit -m "test: 补充 HTTP 客户端重试/退避/超时行为测试"
```

---

### Task 4: tools.ts —— 参数校验（TDD）

**Files:**
- Create: `src/tools.ts`（先只写校验函数）
- Test: `test/tools.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/tools.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/client.js';
import { validateSearchArgs, validateFetchArgs } from '../src/tools.js';

describe('validateSearchArgs', () => {
  it('接受合法参数并保留可选字段', () => {
    const params = validateSearchArgs({
      query: 'DeepSeek',
      count: 5,
      ori_question: '最新模型？',
      localization: '1.2.3.4',
      need_content: true,
    });
    expect(params).toEqual({
      query: 'DeepSeek',
      count: 5,
      ori_question: '最新模型？',
      localization: '1.2.3.4',
      need_content: true,
    });
  });

  it('仅必填 query 也可用，可选字段缺省', () => {
    expect(validateSearchArgs({ query: 'x' })).toEqual({ query: 'x' });
  });

  it('query 缺失/非字符串/空白 → ValidationError', () => {
    expect(() => validateSearchArgs(undefined)).toThrow(ValidationError);
    expect(() => validateSearchArgs({})).toThrow(ValidationError);
    expect(() => validateSearchArgs({ query: '   ' })).toThrow(ValidationError);
    expect(() => validateSearchArgs({ query: 123 })).toThrow(ValidationError);
  });

  it('query 超过 128 字符 → ValidationError', () => {
    expect(() => validateSearchArgs({ query: 'a'.repeat(129) })).toThrow(ValidationError);
  });
});

describe('validateFetchArgs', () => {
  it('接受合法 http/https URL', () => {
    expect(validateFetchArgs({ url: 'https://example.com/a' })).toEqual({
      url: 'https://example.com/a',
    });
  });

  it('拒绝非 URL / 非 http(s) / 带 userinfo / 超长 URL', () => {
    expect(() => validateFetchArgs({ url: 'not a url' })).toThrow(ValidationError);
    expect(() => validateFetchArgs({ url: 'ftp://example.com' })).toThrow(ValidationError);
    expect(() => validateFetchArgs({ url: 'https://user:pass@example.com' })).toThrow(ValidationError);
    expect(() => validateFetchArgs({ url: `https://e.com/${'a'.repeat(8200)}` })).toThrow(ValidationError);
    expect(() => validateFetchArgs(undefined)).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/tools.test.ts`
Expected: FAIL——`../src/tools.js` 不存在

- [ ] **Step 3: 实现 src/tools.ts（本步只含校验函数与常量）**

```ts
import {
  DeepSeekApiError,
  DeepSeekClient,
  FetchResponse,
  SearchParams,
  SearchResult,
  ValidationError,
} from './client.js';

export const SEARCH_TOOL_NAME = 'web_search';
export const FETCH_TOOL_NAME = 'web_fetch';

/** 校验 web_search 入参；仅做本地最小防御，其余交给 API 校验 */
export function validateSearchArgs(args: unknown): SearchParams {
  if (typeof args !== 'object' || args === null) {
    throw new ValidationError('参数必须为对象');
  }
  const { query, count, ori_question, localization, need_content } = args as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new ValidationError('query 必须为非空白字符串');
  }
  if (query.length > 128) {
    throw new ValidationError('query 不能超过 128 个字符');
  }
  const params: SearchParams = { query };
  if (typeof count === 'number') params.count = count;
  if (typeof ori_question === 'string' && ori_question.length > 0) {
    params.ori_question = ori_question;
  }
  if (typeof localization === 'string' && localization.length > 0) {
    params.localization = localization;
  }
  if (typeof need_content === 'boolean') params.need_content = need_content;
  return params;
}

/** 校验 web_fetch 入参：绝对 http(s) URL、无 userinfo、≤8192 字符 */
export function validateFetchArgs(args: unknown): { url: string } {
  if (typeof args !== 'object' || args === null) {
    throw new ValidationError('参数必须为对象');
  }
  const { url } = args as Record<string, unknown>;
  if (typeof url !== 'string' || url.length === 0) {
    throw new ValidationError('url 必须为非空字符串');
  }
  if (url.length > 8192) {
    throw new ValidationError('url 不能超过 8192 个字符');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('url 必须是合法的绝对 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('url 协议必须为 http 或 https');
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError('url 不允许携带用户名或密码');
  }
  if (!parsed.hostname) {
    throw new ValidationError('url 必须包含主机名');
  }
  return { url };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS（8 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: 工具入参本地校验（query/url 最小防御）"
```

---

### Task 5: tools.ts —— Markdown 格式化（TDD）

**Files:**
- Modify: `src/tools.ts`（追加格式化函数）
- Test: `test/tools.test.ts`（追加测试）

- [ ] **Step 1: 追加失败测试**

在 `test/tools.test.ts` 追加（顶部 import 增加 `formatSearchResults, formatFetchedPage` 与 `SearchResult` 类型）：

```ts
import { formatFetchedPage, formatSearchResults, validateFetchArgs, validateSearchArgs } from '../src/tools.js';
import type { SearchResult } from '../src/client.js';
```

```ts
const fullResult: SearchResult = {
  rerank_score: 2.4,
  title: 'DeepSeek V4 模型发布',
  url: 'https://example.com/deepseek-v4',
  snippet: '短摘要',
  summary: '这是长摘要内容，适合模型阅读。',
  content: '',
  site_name: 'Example News',
  site_icon: 'https://example.com/favicon.ico',
  date: '2026-06-01T00:00:00+00:00',
  authority: 3,
};

describe('formatSearchResults', () => {
  it('完整字段按规格输出 Markdown', () => {
    const out = formatSearchResults([fullResult], false);
    expect(out).toContain('共 1 条结果');
    expect(out).toContain('### 1. DeepSeek V4 模型发布');
    expect(out).toContain('- URL: https://example.com/deepseek-v4');
    expect(out).toContain('站点: Example News');
    expect(out).toContain('发布: 2026-06-01');
    expect(out).toContain('权威性: 3/4');
    expect(out).toContain('相关性: 2.4');
    expect(out).toContain('这是长摘要内容，适合模型阅读。');
    expect(out).not.toContain('正文：');
  });

  it('date/site_name 为 null 时省略对应字段；authority=-1 显示未知', () => {
    const out = formatSearchResults(
      [{ ...fullResult, date: null, site_name: null, authority: -1 }],
      false,
    );
    expect(out).not.toContain('发布:');
    expect(out).not.toContain('站点:');
    expect(out).toContain('权威性: 未知');
  });

  it('need_content=true 且有正文时附正文；无正文时省略', () => {
    const withBody = formatSearchResults([{ ...fullResult, content: '正文内容ABC' }], true);
    expect(withBody).toContain('正文：');
    expect(withBody).toContain('正文内容ABC');

    const noBody = formatSearchResults([fullResult], true);
    expect(noBody).not.toContain('正文：');
  });

  it('空结果返回引导文案', () => {
    const out = formatSearchResults([], false);
    expect(out).toContain('没有匹配的结果');
  });
});

describe('formatFetchedPage', () => {
  it('有标题时输出 # 标题 + 空行 + 正文', () => {
    expect(formatFetchedPage({ title: 'Example article', content: '正文' })).toBe(
      '# Example article\n\n正文',
    );
  });

  it('标题为空字符串时仅输出正文', () => {
    expect(formatFetchedPage({ title: '', content: '正文' })).toBe('正文');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/tools.test.ts`
Expected: FAIL——`formatSearchResults` 未导出

- [ ] **Step 3: 在 src/tools.ts 追加实现**

```ts
/** 将 Search 结果格式化为精简 Markdown（面向模型 token 友好） */
export function formatSearchResults(results: SearchResult[], needContent: boolean): string {
  if (results.length === 0) {
    return '搜索完成，但没有匹配的结果。可尝试调整 query 或放宽过滤语法（site:/lang:/after: 等）。';
  }
  const lines: string[] = [`共 ${results.length} 条结果：`, ''];
  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.title}`);
    lines.push(`- URL: ${r.url}`);
    const meta: string[] = [];
    if (r.site_name) meta.push(`站点: ${r.site_name}`);
    if (r.date) meta.push(`发布: ${r.date.slice(0, 10)}`);
    meta.push(`权威性: ${r.authority < 0 ? '未知' : `${r.authority}/4`}`);
    meta.push(`相关性: ${r.rerank_score}`);
    lines.push(`- ${meta.join(' ｜ ')}`);
    lines.push(r.summary);
    if (needContent && r.content) {
      lines.push('', '正文：', '', r.content);
    }
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/** 将 Fetch 结果格式化为 Markdown */
export function formatFetchedPage(page: FetchResponse): string {
  return page.title ? `# ${page.title}\n\n${page.content}` : page.content;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS（14 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: Search/Fetch 结果 Markdown 格式化"
```

---

### Task 6: tools.ts —— 工具定义与 handler 错误映射（TDD）

**Files:**
- Modify: `src/tools.ts`（追加工具定义 + handler）
- Test: `test/tools.test.ts`（追加测试）

- [ ] **Step 1: 追加失败测试**

在 `test/tools.test.ts` 追加（顶部 import 增加 `vi`、`DeepSeekApiError`、handler、工具定义）：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekApiError, DeepSeekClient, ValidationError, type SearchResult } from '../src/client.js';
import {
  FETCH_TOOL_NAME,
  SEARCH_TOOL_NAME,
  fetchToolDefinition,
  formatFetchedPage,
  formatSearchResults,
  handleFetch,
  handleSearch,
  validateFetchArgs,
  validateSearchArgs,
} from '../src/tools.js';
```

```ts
describe('工具定义', () => {
  it('两个工具 name 与 inputSchema.type 正确', () => {
    expect(SEARCH_TOOL_NAME).toBe('web_search');
    expect(FETCH_TOOL_NAME).toBe('web_fetch');
    expect(searchToolDefinition.inputSchema.type).toBe('object');
    expect(searchToolDefinition.inputSchema.required).toEqual(['query']);
    expect(fetchToolDefinition.inputSchema.required).toEqual(['url']);
    expect(searchToolDefinition.inputSchema.properties.query.maxLength).toBe(128);
    expect(fetchToolDefinition.inputSchema.properties.url.maxLength).toBe(8192);
  });
});

function stubClient(): DeepSeekClient & { search: ReturnType<typeof vi.fn>; fetchUrl: ReturnType<typeof vi.fn> } {
  return { search: vi.fn(), fetchUrl: vi.fn() } as unknown as DeepSeekClient & {
    search: ReturnType<typeof vi.fn>;
    fetchUrl: ReturnType<typeof vi.fn>;
  };
}

describe('handleSearch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('成功 → 正常 result，text 含格式化结果', async () => {
    const client = stubClient();
    client.search.mockResolvedValue({ results: [fullResult] });
    const res = await handleSearch(client, { query: 'DeepSeek' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect((res.content[0] as { text: string }).text).toContain('DeepSeek V4 模型发布');
    expect(client.search).toHaveBeenCalledWith({ query: 'DeepSeek' });
  });

  it('ValidationError → isError 且消息含「参数错误」', async () => {
    const res = await handleSearch(stubClient(), { query: '  ' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('参数错误');
  });

  it('402 → isError 且提示充值；不重试语义透传', async () => {
    const client = stubClient();
    client.search.mockRejectedValue(new DeepSeekApiError(402, 'insufficient balance'));
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('余额不足');
  });

  it('401 → isError 且提示 API Key', async () => {
    const client = stubClient();
    client.search.mockRejectedValue(new DeepSeekApiError(401, 'invalid key'));
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('API Key');
  });

  it('未知异常 → isError 且透传 message', async () => {
    const client = stubClient();
    client.search.mockRejectedValue(new Error('boom'));
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('boom');
  });
});

describe('handleFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('成功 → text 为 # 标题 + 正文', async () => {
    const client = stubClient();
    client.fetchUrl.mockResolvedValue({ title: 'Example', content: 'hello' });
    const res = await handleFetch(client, { url: 'https://example.com' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toBe('# Example\n\nhello');
  });

  it('404 → isError 且给出语义化建议', async () => {
    const client = stubClient();
    client.fetchUrl.mockRejectedValue(new DeepSeekApiError(404, 'no content'));
    const res = await handleFetch(client, { url: 'https://example.com/404' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('无法抓取');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/tools.test.ts`
Expected: FAIL——`searchToolDefinition` 等未导出

- [ ] **Step 3: 在 src/tools.ts 追加实现**

顶部追加 import：

```ts
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
```

文件末尾追加：

```ts
export const searchToolDefinition: Tool = {
  name: SEARCH_TOOL_NAME,
  description:
    '使用 DeepSeek 搜索引擎搜索网页，返回带排序分数、权威性、发布时间的结构化结果。' +
    'query 支持 site: / -site: / "精确短语" / lang:zh,en / after:2025 / before:2026 / -排除词 等语法。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          '搜索词，1~128 个字符，不能全为空白。支持搜索语法：site:github.com、-site:example.com、"精确短语"、lang:zh,en、after:2025-01-01、before:2026、-排除词',
      },
      count: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，1~50，默认 10' },
      ori_question: {
        type: 'string',
        maxLength: 128,
        description: '触发搜索的用户原始问题（可选），有助于更好地理解搜索意图',
      },
      localization: { type: 'string', description: '用于优先返回本地化搜索结果的 IP 地址（可选）' },
      need_content: {
        type: 'boolean',
        description: '是否同时返回网页正文，默认 false。正文较长，仅在需要阅读全文时开启',
      },
    },
    required: ['query'],
  },
};

export const fetchToolDefinition: Tool = {
  name: FETCH_TOOL_NAME,
  description:
    '抓取单个网页，返回页面标题与 Markdown 正文。适用于读取 web_search 结果中某个 URL 的完整内容。',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        maxLength: 8192,
        description: '要抓取的网页地址，必须为含主机的 http/https URL，不允许携带用户名或密码',
      },
    },
    required: ['url'],
  },
};

/** 将异常映射为模型可读的错误文案 */
export function describeError(err: unknown): string {
  if (err instanceof ValidationError) {
    return `参数错误：${err.message}`;
  }
  if (err instanceof DeepSeekApiError) {
    switch (err.status) {
      case 400:
        return `请求不合法（400）：${err.message}`;
      case 401:
        return `认证失败（401）：DEEPSEEK_API_KEY 缺失或无效，请检查环境变量配置。`;
      case 402:
        return `账户余额不足（402）：请前往 DeepSeek 开放平台充值后重试。`;
      case 403:
        return `请求被拒绝（403）：目标站点被安全策略拦截。`;
      case 404:
        return `无法抓取该网页（404）：页面不可用、被站点策略拦截或没有可提取的正文。可尝试其他 URL。`;
      case 413:
        return `请求体过大（413）。`;
      case 429:
        return `请求过于频繁（429）：Search/Fetch 各有 5 QPS 限制，请稍后重试。`;
      default:
        return `DeepSeek API 错误（${err.status}）：${err.message}`;
    }
  }
  return `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
}

function toErrorResult(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

/** web_search 工具 handler */
export async function handleSearch(client: DeepSeekClient, args: unknown): Promise<CallToolResult> {
  try {
    const params = validateSearchArgs(args);
    const needContent = params.need_content ?? false;
    const res = await client.search(params);
    return { content: [{ type: 'text', text: formatSearchResults(res.results, needContent) }] };
  } catch (err) {
    return toErrorResult(err);
  }
}

/** web_fetch 工具 handler */
export async function handleFetch(client: DeepSeekClient, args: unknown): Promise<CallToolResult> {
  try {
    const { url } = validateFetchArgs(args);
    const page = await client.fetchUrl(url);
    return { content: [{ type: 'text', text: formatFetchedPage(page) }] };
  } catch (err) {
    return toErrorResult(err);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS（22 个测试全绿）

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（0 错误）

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: web_search/web_fetch 工具定义与 handler 错误映射"
```

---

### Task 7: index.ts 入口 + stdio 端到端测试

**Files:**
- Create: `src/index.ts`
- Test: `test/stdio.e2e.test.ts`

- [ ] **Step 1: 写端到端测试（先写测试）**

创建 `test/stdio.e2e.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, '..', 'src', 'index.ts');

interface Recorded {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let httpServer: Server;
let baseUrl = '';
const recorded: Recorded[] = [];

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      recorded.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      const reply =
        req.url === '/v1/tools/fetch'
          ? { title: 'Example article', content: '# Example article\n\nArticle content.' }
          : {
              results: [
                {
                  rerank_score: 2.4,
                  title: 'DeepSeek V4 模型发布',
                  url: 'https://example.com/deepseek-v4',
                  snippet: '短摘要',
                  summary: '长摘要内容',
                  content: '',
                  site_name: 'Example News',
                  site_icon: null,
                  date: '2026-06-01T00:00:00+00:00',
                  authority: 3,
                },
              ],
            };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  httpServer.close();
});

function startServer(): ChildProcess {
  return spawn('npx', ['tsx', ENTRY], {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 发送一行 JSON-RPC，等待 id 匹配的响应 */
function rpc(child: ChildProcess, msg: { id: number } & Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === msg.id) {
            child.stdout?.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
    child.once('exit', (code) => reject(new Error(`server exited early (code ${code})`)));
  });
}

function notify(child: ChildProcess, msg: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

describe('stdio 端到端', () => {
  it('initialize 握手 + tools/list 暴露两个工具及 schema', async () => {
    const child = startServer();
    try {
      const initRes = await rpc(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest-client', version: '0.0.1' },
        },
      });
      expect(initRes.result.serverInfo.name).toBe('deepseek-websearch-mcp');
      notify(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const listRes = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const names = listRes.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(['web_fetch', 'web_search']);
      const search = listRes.result.tools.find((t: { name: string }) => t.name === 'web_search');
      expect(search.inputSchema.required).toEqual(['query']);
      expect(search.inputSchema.properties.count.maximum).toBe(50);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('tools/call web_search 走本地 stub：鉴权头与请求体正确，返回格式化文本', async () => {
    recorded.length = 0;
    const child = startServer();
    try {
      await rpc(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest-client', version: '0.0.1' },
        },
      });
      notify(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const callRes = await rpc(child, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: { query: 'DeepSeek 发布', count: 5 },
        },
      });

      expect(recorded).toHaveLength(1);
      expect(recorded[0].path).toBe('/v1/tools/search');
      expect(recorded[0].authorization).toBe('Bearer test-key');
      expect(recorded[0].body).toEqual({ query: 'DeepSeek 发布', count: 5 });

      expect(callRes.result.isError).toBeUndefined();
      const text = (callRes.result.content[0] as { text: string }).text;
      expect(text).toContain('共 1 条结果');
      expect(text).toContain('DeepSeek V4 模型发布');
      expect(text).toContain('发布: 2026-06-01');
    } finally {
      child.kill();
    }
  }, 30_000);

  it('缺失 DEEPSEEK_API_KEY 时以 exit 1 退出并在 stderr 报错', async () => {
    const child = spawn('npx', ['tsx', ENTRY], {
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderr = await new Promise<string>((resolve) => {
      let out = '';
      child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', () => resolve(out));
    });
    expect(stderr).toContain('DEEPSEEK_API_KEY');
    expect(stderr).toContain('deepseek-websearch-mcp');
  }, 30_000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/stdio.e2e.test.ts`
Expected: FAIL——`src/index.ts` 不存在，子进程以非 0 退出

- [ ] **Step 3: 实现 src/index.ts**

```ts
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DeepSeekClient } from './client.js';
import {
  FETCH_TOOL_NAME,
  SEARCH_TOOL_NAME,
  fetchToolDefinition,
  handleFetch,
  handleSearch,
  searchToolDefinition,
} from './tools.js';

const NAME = 'deepseek-websearch-mcp';
const VERSION = '0.1.0';

/** 读取并校验必需环境变量；缺失时报错退出（诊断信息走 stderr） */
function readApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    console.error(`${NAME}: environment variable DEEPSEEK_API_KEY is required`);
    process.exit(1);
  }
  return key;
}

async function main(): Promise<void> {
  const client = new DeepSeekClient({
    apiKey: readApiKey(),
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    timeoutMs: process.env.DEEPSEEK_TIMEOUT_MS
      ? Number(process.env.DEEPSEEK_TIMEOUT_MS)
      : undefined,
  });

  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [searchToolDefinition, fetchToolDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case SEARCH_TOOL_NAME:
        return handleSearch(client, args);
      case FETCH_TOOL_NAME:
        return handleFetch(client, args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`${NAME}:`, err);
  process.exit(1);
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/stdio.e2e.test.ts`
Expected: PASS（3 个测试全绿）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 错误；全部测试 PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/stdio.e2e.test.ts
git commit -m "feat: stdio MCP server 入口与端到端测试"
```

---

### Task 8: 可选真实 API 集成测试

**Files:**
- Test: `test/integration.test.ts`

- [ ] **Step 1: 写集成测试（skipIf 门控）**

创建 `test/integration.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DeepSeekClient } from '../src/client.js';

const API_KEY = process.env.DEEPSEEK_API_KEY?.trim();

describe.skipIf(!API_KEY)('DeepSeek 真实 API 集成（需 DEEPSEEK_API_KEY）', () => {
  it('web_search 真实搜索返回结构化结果', async () => {
    const client = new DeepSeekClient({ apiKey: API_KEY! });
    const res = await client.search({ query: 'DeepSeek', count: 3 });
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]).toHaveProperty('url');
  }, 60_000);

  it('web_fetch 真实抓取 example.com 返回正文', async () => {
    const client = new DeepSeekClient({ apiKey: API_KEY! });
    const page = await client.fetchUrl('https://example.com');
    expect(typeof page.content).toBe('string');
    expect(page.content.length).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 2: 无 Key 时验证自动跳过**

Run: `env -u DEEPSEEK_API_KEY npx vitest run test/integration.test.ts`
Expected: skipped（suite 跳过，不失败）

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test: 可选真实 API 集成测试（无 Key 自动跳过）"
```

---

### Task 9: 构建产物 + npm pack 发布验证

**Files:**
- Create: `dist/`（构建产物，不入库）

- [ ] **Step 1: 构建**

Run: `npm run build`
Expected: `dist/index.js`、`dist/client.js`、`dist/tools.js` 生成；`dist/index.js` 首行为 `#!/usr/bin/env node`

验证: `head -1 dist/index.js`

- [ ] **Step 2: 构建 CLI 冒烟（无 Key 应 exit 1）**

Run: `node dist/index.js; echo "exit=$?"`
Expected: stderr 输出 `deepseek-websearch-mcp: environment variable DEEPSEEK_API_KEY is required`，`exit=1`

- [ ] **Step 3: npm pack 验证 tarball 内容**

Run: `npm pack --dry-run`
Expected: tarball 仅含 `dist/`（3 个 .js 文件）、`README.md`、`package.json`、`LICENSE`；不含 `src/`、`test/`、`docs/`

- [ ] **Step 4: 真实 pack 留档验证（可选）并清理**

Run: `npm pack && tar -tzf deepseek-websearch-mcp-0.1.0.tgz && rm deepseek-websearch-mcp-0.1.0.tgz`
Expected: 同 Step 3 白名单

- [ ] **Step 5: Commit（若有 .gitignore 变更）**

无变更则跳过；`*.tgz` 已在 Task 1 加入 .gitignore。

---

### Task 10: README 与发布推送

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README.md**

```markdown
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
npx -y github:xinzhuang/deepseek-websearch-mcp
```

> 发布到 npm 后可简写为 `npx -y deepseek-websearch-mcp`。

### 方式二：全局安装

```bash
npm install -g github:xinzhuang/deepseek-websearch-mcp
deepseek-websearch-mcp
```

### 方式三：客户端配置

**Claude Code**

```bash
claude mcp add deepseek-websearch -s user -e DEEPSEEK_API_KEY=sk-你的key -- npx -y github:xinzhuang/deepseek-websearch-mcp
```

**Cursor / 通用 JSON（`mcp.json`）**

```json
{
  "mcpServers": {
    "deepseek-websearch": {
      "command": "npx",
      "args": ["-y", "github:xinzhuang/deepseek-websearch-mcp"],
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
      "args": ["-y", "github:xinzhuang/deepseek-websearch-mcp"],
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
```

- [ ] **Step 2: 全量门禁**

Run: `npm run typecheck && npm test`
Expected: 0 类型错误；全部测试 PASS（1 个 suite 跳过若无 Key）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 添加 README（安装配置/工具说明/客户端接入）"
```

- [ ] **Step 4: 推送 GitHub**

Run: `git push -u origin main`
Expected: 推送成功。若远端仓库不存在（`ERROR: Repository not found`），执行：
`gh repo create xinzhuang/deepseek-websearch-mcp --public --source . --push`（公开仓库），然后重试 push。

- [ ] **Step 5: 打 tag 并推送**

Run: `git tag v0.1.0 && git push origin v0.1.0`
Expected: tag 推送成功

- [ ] **Step 6: 验证远端状态**

Run: `git log --oneline -5 && git status && gh repo view xinzhuang/deepseek-websearch-mcp --json url -q .url`
Expected: 工作区 clean，全部提交已推送，输出仓库 URL

---

## 自审记录（Self-Review）

1. **规格覆盖**：§2 API 规格 → Task 2/3；§4 环境变量 → Task 7（index）+ client timeoutMs；§5 工具定义/输出/本地校验 → Task 4/5/6；§6 错误处理/重试/exit1 → Task 3/6/7；§7 四层测试+门禁 → Task 2-8/10；§8 发布配置 → Task 1（package.json 字段）+ Task 9（pack）+ Task 10（README/推送）；§9 目录结构 → 全局一致。无缺口。
2. **占位符扫描**：所有代码块为完整可编译内容，无 TBD/TODO。
3. **类型一致性**：`SearchResult/SearchParams/FetchResponse/DeepSeekApiError/ValidationError` 定义于 Task 2，Task 4/5/6/7/8 引用一致；`handleSearch/handleFetch(client, args)` 签名 Task 6 定义、Task 7 调用一致；`sleep` 注入项 Task 2 定义、Task 3 测试使用一致。
