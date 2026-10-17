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
