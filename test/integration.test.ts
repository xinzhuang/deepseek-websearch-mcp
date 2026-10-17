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
