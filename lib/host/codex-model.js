/**
 * Codex 模型插件——把 Codex /responses 端点的流式响应转成 DSH 模型流。
 *
 * DSH 的循环负责工具/审批/编排；这一行只回答「向模型要下一句话」。
 * 复用本地 Codex CLI 的 OAuth 凭据（~/.codex/auth.json），不需要 ACP 子进程。
 */
import { loadCredential, refreshCredential } from "./codex/auth.js";
import { CODEX_RESPONSES_URL, buildHeaders } from "./codex/endpoints.js";
import { buildResponsesBody } from "./codex/request.js";
import { parseResponsesStream, CodexStreamError } from "./codex/stream.js";
import { describeError, redactDiagnostic, recoveryCode } from "./codex/diagnostics.js";
import { loadCatalog } from "./codex/catalog.js";
import { applySelection, currentSelection } from "./codex/selection.js";
import { updateQuota } from "./codex/quota.js";
/**
 * 运行时清单与声明清单合并出真正发布的那一份。
 * 运行时（catalog cache）优先；它没报的字段用声明兜底。
 */
export function mergeDeclaredModels(declared, runtime) {
    const byId = new Map(runtime.map(m => [m.id, m]));
    return declared.map(entry => {
        const found = byId.get(entry.id);
        const name = found?.name ?? entry.name;
        const description = found?.description ?? entry.description;
        const contextWindow = found?.contextWindow ?? entry.contextWindow;
        const result = { id: entry.id, name };
        if (description !== undefined)
            result.description = description;
        if (contextWindow !== undefined)
            result.contextWindow = contextWindow;
        return result;
    });
}
/** 每一行的清单发布口（写进目录的运行时账本）。 */
const publishers = new Map();
/**
 * 重新加载模型清单并发布到运行时账本。
 *
 * 发布的是用户勾过的那几个：设置里勾了什么，选择器里就只剩什么。
 */
export async function refreshCodexModels() {
    const catalog = await loadCatalog();
    const reported = applySelection(catalog.map(m => ({
        id: m.id,
        name: m.name,
        ...(m.description === undefined ? {} : { description: m.description }),
        contextWindow: m.contextWindow,
        efforts: m.efforts,
    })), currentSelection());
    for (const publish of publishers.values()) {
        publish(reported);
    }
}
/**
 * 创建 Codex 模型流函数。
 * 检查 preset 的 agent 是否为 'codex-global'，是则返回流函数，否则返回 undefined。
 */
export function codexModelStream(config, deps) {
    // Register publishers for all codex-global presets upfront so models are
    // available in the picker before the first stream call.
    if (deps?.onRuntimeModels) {
        for (const [presetId, preset] of Object.entries(config.presets)) {
            if (preset.agent !== 'codex-global')
                continue;
            if (!publishers.has(presetId)) {
                publishers.set(presetId, (models) => deps.onRuntimeModels(presetId, models));
            }
        }
        // Trigger initial catalog load for all registered publishers
        for (const presetId of publishers.keys()) {
            loadCatalog().then(catalog => {
                const reported = applySelection(catalog.map(m => ({
                    id: m.id,
                    name: m.name,
                    ...(m.description === undefined ? {} : { description: m.description }),
                    contextWindow: m.contextWindow,
                    efforts: m.efforts,
                })), currentSelection());
                deps.onRuntimeModels(presetId, reported);
            }).catch(() => { });
        }
    }
    return (presetId, request) => {
        const preset = config.presets[presetId];
        if (preset === undefined || preset.agent !== 'codex-global')
            return undefined;
        return streamWithDiagnostics(presetId, request);
    };
}
/** One attempt only: the host owns retry delays, attempt persistence and cancellation. */
async function* streamWithDiagnostics(presetId, request) {
    try {
        yield* streamCodex(presetId, request);
    }
    catch (error) {
        const diagnostic = describeError(error);
        const aborted = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: {
                    code: aborted ? 'ABORTED' : recoveryCode(diagnostic.code) ?? 'request-error',
                    message: `Codex 请求失败：${diagnostic.detail}`,
                } } };
    }
}
async function* streamCodex(_presetId, request) {
    // 1. Load credential
    let credential = await loadCredential();
    if (credential === undefined) {
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: '未找到 Codex 登录凭据，请在终端运行 codex login', code: 'no-credential' } },
        };
        return;
    }
    // 2. Build request body
    const messages = (request.messages ?? []);
    // Strip [effort] suffix if present (collapseEfforts folds base[effort] → base)
    const body = buildResponsesBody({
        model: request.model,
        messages,
        system: typeof request.system === 'string' ? request.system : undefined,
        tools: request.tools,
        reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined,
        maxTokens: typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
    });
    const signal = request.signal;
    // 3. POST to /responses
    let res = await fetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: buildHeaders(credential, request.model),
        body: JSON.stringify(body),
        signal,
    });
    // 4. On 401: refresh token and retry once
    if (res.status === 401) {
        try {
            credential = await refreshCredential(credential);
        }
        catch {
            yield {
                type: 'finish',
                reason: { kind: 'error', failure: { message: 'Codex 登录已过期，请重新登录', code: 'auth-expired' } },
            };
            return;
        }
        res = await fetch(CODEX_RESPONSES_URL, {
            method: 'POST',
            headers: buildHeaders(credential, request.model),
            body: JSON.stringify(body),
            signal,
        });
        if (res.status === 401) {
            yield {
                type: 'finish',
                reason: { kind: 'error', failure: { message: 'Codex 登录已过期，请重新登录', code: 'auth-expired' } },
            };
            return;
        }
    }
    // 5. Update quota from response headers
    const responseHeaders = {};
    res.headers.forEach((value, key) => { responseHeaders[key] = value; });
    updateQuota(responseHeaders, credential.accountId);
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error('[codex] request failed', res.status, request.model, errBody.slice(0, 200));
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: `Codex 请求失败 (${res.status}): ${errBody.slice(0, 100)}`, code: 'http-error' } },
        };
        return;
    }
    // 6. Parse stream and yield chunks
    const bodyStream = res.body;
    if (bodyStream === null) {
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'Codex 响应没有 body', code: 'no-body' } },
        };
        return;
    }
    // Convert ReadableStream to AsyncIterable<string | Uint8Array>
    const reader = bodyStream.getReader();
    const secrets = [credential.accessToken, credential.refreshToken, credential.accountId].filter((value) => typeof value === 'string');
    const requestId = res.headers.get('x-request-id') ?? res.headers.get('openai-request-id');
    let readFailed = false;
    let nextIndex = 0;
    let sawToolCall = false;
    let active;
    function* closeBlock() {
        if (active === undefined)
            return;
        yield { type: 'block-end', index: active.index, block: { type: active.type, text: active.text } };
        active = undefined;
    }
    async function* toAsyncIterable() {
        while (true) {
            let result;
            try {
                result = await reader.read();
            }
            catch (error) {
                readFailed = true;
                throw error;
            }
            const { done, value } = result;
            if (done)
                break;
            yield value;
        }
    }
    try {
        for await (const event of parseResponsesStream(toAsyncIterable())) {
            switch (event.type) {
                case 'text':
                case 'reasoning': {
                    if (active?.type !== event.type) {
                        yield* closeBlock();
                        active = { index: nextIndex++, type: event.type, text: '' };
                        yield { type: 'block-start', index: active.index, blockType: active.type };
                    }
                    active.text += event.text;
                    yield { type: event.type === 'text' ? 'text-delta' : 'reasoning-delta', index: active.index, text: event.text };
                    break;
                }
                case 'tool_call': {
                    yield* closeBlock();
                    const index = nextIndex++;
                    sawToolCall = true;
                    yield { type: 'block-start', index, blockType: 'tool-call' };
                    yield { type: 'tool-call-delta', index, id: event.id, name: event.name, argumentsDelta: event.arguments };
                    yield { type: 'block-end', index, block: { type: 'tool-call', id: event.id, name: event.name, arguments: event.arguments } };
                    break;
                }
                case 'finish': {
                    yield* closeBlock();
                    yield { type: 'finish', reason: { kind: event.reason === 'stop' && sawToolCall ? 'tool-calls' : event.reason } };
                    return;
                }
                case 'error': {
                    yield* closeBlock();
                    yield { type: 'finish', reason: { kind: 'error', failure: { message: event.message, code: event.code } } };
                    return;
                }
            }
        }
    }
    catch (err) {
        yield* closeBlock();
        const diagnostic = describeError(err, secrets);
        const aborted = signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
        const category = aborted ? '请求已取消' : err instanceof CodexStreamError ? '流式响应中断' : readFailed ? '响应流读取失败' : '流式响应解析失败';
        const message = `Codex ${category}：${diagnostic.detail}${requestId ? ` (request_id=${redactDiagnostic(requestId, secrets)})` : ''}`;
        const code = aborted ? 'ABORTED' : recoveryCode(diagnostic.code) ?? (err instanceof CodexStreamError ? 'TRANSPORT' : 'stream-error');
        // Log the same sanitized facts that are persisted in assistant/attempt.
        // Logging must never replace the original failure with another exception.
        try {
            console.error('[codex]', message);
        }
        catch { /* diagnostic sink unavailable */ }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: { message, code } } };
    }
    finally {
        reader.releaseLock();
    }
}
