import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
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
  const { query, count, ori_question, localization, need_content } = args as Record<
    string,
    unknown
  >;
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
      localization: {
        type: 'string',
        description: '用于优先返回本地化搜索结果的 IP 地址（可选）',
      },
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
        return '认证失败（401）：DEEPSEEK_API_KEY 缺失或无效，请检查环境变量配置。';
      case 402:
        return '账户余额不足（402）：请前往 DeepSeek 开放平台充值后重试。';
      case 403:
        return '请求被拒绝（403）：目标站点被安全策略拦截。';
      case 404:
        return '无法抓取该网页（404）：页面不可用、被站点策略拦截或没有可提取的正文。可尝试其他 URL。';
      case 413:
        return '请求体过大（413）。';
      case 429:
        return '请求过于频繁（429）：Search/Fetch 各有 5 QPS 限制，请稍后重试。';
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
