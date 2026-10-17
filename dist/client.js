/** 上游返回的非 2xx 状态；retryable 遵循官方指引：408/429/5xx 可重试 */
export class DeepSeekApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'DeepSeekApiError';
    }
    get retryable() {
        return this.status === 408 || this.status === 429 || this.status >= 500;
    }
}
/** 本地参数校验失败（在请求发出前拦截） */
export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60_000;
/** 首发尝试 + 最多 2 次重试 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];
/** DeepSeek Search/Fetch HTTP 客户端（Bearer 鉴权、超时、可重试错误退避重试） */
export class DeepSeekClient {
    options;
    baseUrl;
    sleep;
    constructor(options) {
        this.options = options;
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    async search(params) {
        return (await this.post('/v1/tools/search', params));
    }
    async fetchUrl(url) {
        return (await this.post('/v1/tools/fetch', { url }));
    }
    async post(path, body) {
        let lastError;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return await this.postOnce(path, body);
            }
            catch (err) {
                if (!(err instanceof DeepSeekApiError) || !err.retryable)
                    throw err;
                lastError = err;
                if (attempt < MAX_ATTEMPTS - 1)
                    await this.sleep(BACKOFF_MS[attempt]);
            }
        }
        throw lastError;
    }
    async postOnce(path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok)
                throw new DeepSeekApiError(res.status, await extractErrorMessage(res));
            return await res.json();
        }
        catch (err) {
            if (err instanceof DeepSeekApiError)
                throw err;
            if (controller.signal.aborted)
                throw new DeepSeekApiError(408, '请求超时');
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
async function extractErrorMessage(res) {
    try {
        const data = (await res.json());
        return data.error?.message ?? `HTTP ${res.status}`;
    }
    catch {
        return `HTTP ${res.status}`;
    }
}
