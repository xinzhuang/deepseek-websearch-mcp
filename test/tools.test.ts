import { describe, expect, it } from 'vitest';
import { ValidationError, type SearchResult } from '../src/client.js';
import {
  formatFetchedPage,
  formatSearchResults,
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
