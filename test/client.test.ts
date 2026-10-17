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

    const client = new DeepSeekClient({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9999/',
      sleep: noopSleep,
    });
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
