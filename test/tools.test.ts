import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/client.js';
import { validateFetchArgs, validateSearchArgs } from '../src/tools.js';

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
