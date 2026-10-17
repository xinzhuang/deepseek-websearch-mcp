import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekApiError, DeepSeekClient } from '../src/client.js';

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
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        error: {
          message: 'insufficient balance',
          type: 'insufficient_balance',
          param: null,
          code: null,
        },
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
