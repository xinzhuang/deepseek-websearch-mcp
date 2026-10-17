#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { DeepSeekClient } from './client.js';
import { FETCH_TOOL_NAME, SEARCH_TOOL_NAME, fetchToolDefinition, handleFetch, handleSearch, searchToolDefinition, } from './tools.js';
const NAME = 'deepseek-websearch-mcp';
const VERSION = '0.1.0';
/** 读取并校验必需环境变量；缺失时报错退出（诊断信息走 stderr） */
function readApiKey() {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    if (!key) {
        console.error(`${NAME}: environment variable DEEPSEEK_API_KEY is required`);
        process.exit(1);
    }
    return key;
}
async function main() {
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
