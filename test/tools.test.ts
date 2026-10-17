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
  searchToolDefinition,
  validateFetchArgs,
  validateSearchArgs,
} from '../src/tools.js';

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
    expect(() => validateFetchArgs({ url: 'https://user:pass@example.com' })).toThrow(
      ValidationError,
    );
    expect(() => validateFetchArgs({ url: `https://e.com/${'a'.repeat(8200)}` })).toThrow(
      ValidationError,
    );
    expect(() => validateFetchArgs(undefined)).toThrow(ValidationError);
  });
});

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

describe('工具定义', () => {
  it('两个工具 name 与 inputSchema 正确', () => {
    expect(SEARCH_TOOL_NAME).toBe('web_search');
    expect(FETCH_TOOL_NAME).toBe('web_fetch');
    expect(searchToolDefinition.inputSchema.type).toBe('object');
    expect(searchToolDefinition.inputSchema.required).toEqual(['query']);
    expect(fetchToolDefinition.inputSchema.required).toEqual(['url']);
    expect(searchToolDefinition.inputSchema.properties.query.maxLength).toBe(128);
    expect(fetchToolDefinition.inputSchema.properties.url.maxLength).toBe(8192);
  });
});

function stubClient(): DeepSeekClient {
  return { search: vi.fn(), fetchUrl: vi.fn() } as unknown as DeepSeekClient;
}

describe('handleSearch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('成功 → 正常 result，text 含格式化结果', async () => {
    const client = stubClient();
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [fullResult] });
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

  it('402 → isError 且提示充值', async () => {
    const client = stubClient();
    (client.search as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeepSeekApiError(402, 'insufficient balance'),
    );
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('余额不足');
  });

  it('401 → isError 且提示 API Key', async () => {
    const client = stubClient();
    (client.search as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeepSeekApiError(401, 'invalid key'),
    );
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('API_KEY');
  });

  it('未知异常 → isError 且透传 message', async () => {
    const client = stubClient();
    (client.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const res = await handleSearch(client, { query: 'x' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('boom');
  });
});

describe('handleFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('成功 → text 为 # 标题 + 正文', async () => {
    const client = stubClient();
    (client.fetchUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: 'Example',
      content: 'hello',
    });
    const res = await handleFetch(client, { url: 'https://example.com' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toBe('# Example\n\nhello');
  });

  it('404 → isError 且给出语义化建议', async () => {
    const client = stubClient();
    (client.fetchUrl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DeepSeekApiError(404, 'no content'),
    );
    const res = await handleFetch(client, { url: 'https://example.com/404' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('无法抓取');
  });
});
