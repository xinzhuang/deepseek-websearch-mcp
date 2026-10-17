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
