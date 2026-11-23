/**
 * Codex 模型插件——把 Codex /responses 端点的流式响应转成 DSH 模型流。
 *
 * DSH 的循环负责工具/审批/编排；这一行只回答「向模型要下一句话」。
 * 复用本地 Codex CLI 的 OAuth 凭据（~/.codex/auth.json），不需要 ACP 子进程。
 */

import type { ModelTurnRequest, ModelStreamChunk } from './modelkit/index.ts'
import type { PresetConfig } from './registry.ts'
import { loadCredential, refreshCredential } from './codex/auth.ts'
import { CODEX_RESPONSES_URL, buildHeaders } from './codex/endpoints.ts'
import { buildResponsesBody } from './codex/request.ts'
import { parseResponsesStream, CodexStreamError } from './codex/stream.ts'
import { describeError, redactDiagnostic, recoveryCode } from './codex/diagnostics.ts'
import { loadCatalog } from './codex/catalog.ts'
import { applySelection, currentSelection } from './codex/selection.ts'
import { updateQuota } from './codex/quota.ts'

/** 运行时清单写进目录账本时用的形状。 */
export type CodexReportedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly contextWindow?: number | undefined
  /** 这个型号自己支持的强度；选择器的强度轴按它画，别一律用声明那份。 */
  readonly efforts?: readonly string[] | undefined
}

/**
 * 运行时清单与声明清单合并出真正发布的那一份。
 * 运行时（catalog cache）优先；它没报的字段用声明兜底。
 */
export function mergeDeclaredModels(
  declared: readonly { id: string; name: string; description?: string; contextWindow?: number }[],
  runtime: readonly CodexReportedModel[],
): CodexReportedModel[] {
  const byId = new Map(runtime.map(m => [m.id, m]))
  return declared.map(entry => {
    const found = byId.get(entry.id)
    const name = found?.name ?? entry.name
    const description = found?.description ?? entry.description
    const contextWindow = found?.contextWindow ?? entry.contextWindow
    const result: CodexReportedModel & { description?: string; contextWindow?: number } = { id: entry.id, name }
    if (description !== undefined) result.description = description
    if (contextWindow !== undefined) result.contextWindow = contextWindow
    return result
  })
}

/** 每一行的清单发布口（写进目录的运行时账本）。 */
const publishers = new Map<string, (models: readonly CodexReportedModel[]) => void>()

/**
 * 重新加载模型清单并发布到运行时账本。
 *
 * 发布的是用户勾过的那几个：设置里勾了什么，选择器里就只剩什么。
 */
export async function refreshCodexModels(): Promise<void> {
  const catalog = await loadCatalog()
  const reported: readonly CodexReportedModel[] = applySelection(
    catalog.map(m => ({
      id: m.id,
      name: m.name,
      ...(m.description === undefined ? {} : { description: m.description }),
      contextWindow: m.contextWindow,
      efforts: m.efforts,
    })),
    currentSelection(),
  )
  for (const publish of publishers.values()) {
    publish(reported)
  }
}

type StreamDeps = {
  onRuntimeModels?: (presetId: string, models: readonly CodexReportedModel[]) => void
}

/**
 * 创建 Codex 模型流函数。
 * 检查 preset 的 agent 是否为 'codex-global'，是则返回流函数，否则返回 undefined。
 */
export function codexModelStream(
  config: PresetConfig,
  deps?: StreamDeps,
): (presetId: string, request: ModelTurnRequest) => AsyncGenerator<ModelStreamChunk> | undefined {
  // Register publishers for all codex-global presets upfront so models are
  // available in the picker before the first stream call.
  if (deps?.onRuntimeModels) {
    for (const [presetId, preset] of Object.entries(config.presets)) {
      if (preset.agent !== 'codex-global') continue
      if (!publishers.has(presetId)) {
        publishers.set(presetId, (models) => deps.onRuntimeModels!(presetId, models))
      }
    }
    // Trigger initial catalog load for all registered publishers
    for (const presetId of publishers.keys()) {
      loadCatalog().then(catalog => {
        const reported: readonly CodexReportedModel[] = applySelection(
          catalog.map(m => ({
            id: m.id,
            name: m.name,
            ...(m.description === undefined ? {} : { description: m.description }),
            contextWindow: m.contextWindow,
            efforts: m.efforts,
          })),
          currentSelection(),
        )
        deps.onRuntimeModels!(presetId, reported)
      }).catch(() => {})
    }
  }

  return (presetId: string, request: ModelTurnRequest): AsyncGenerator<ModelStreamChunk> | undefined => {
    const preset = config.presets[presetId]
    if (preset === undefined || preset.agent !== 'codex-global') return undefined

    return streamWithDiagnostics(presetId, request)
  }
}

/** One attempt only: the host owns retry delays, attempt persistence and cancellation. */
async function* streamWithDiagnostics(presetId: string, request: ModelTurnRequest): AsyncGenerator<ModelStreamChunk> {
  try { yield* streamCodex(presetId, request) }
  catch (error) {
    const diagnostic = describeError(error)
    const aborted = (request.signal as AbortSignal | undefined)?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: {
      code: aborted ? 'ABORTED' : recoveryCode(diagnostic.code) ?? 'request-error',
      message: `Codex 请求失败：${diagnostic.detail}`,
    } } }
  }
}

async function* streamCodex(
  _presetId: string,
  request: ModelTurnRequest,
): AsyncGenerator<ModelStreamChunk> {
  // 1. Load credential
  let credential = await loadCredential()
  if (credential === undefined) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: '未找到 Codex 登录凭据，请在终端运行 codex login', code: 'no-credential' } },
    }
    return
  }

  // 2. Build request body
  const messages = (request.messages ?? []) as { role: string; content: string }[]
  // Strip [effort] suffix if present (collapseEfforts folds base[effort] → base)
  const body = buildResponsesBody({
    model: request.model,
    messages,
    system: typeof request.system === 'string' ? request.system : undefined,
    tools: request.tools,
    reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined,
    maxTokens: typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
  })

  const signal = request.signal as AbortSignal | undefined

  // 3. POST to /responses
  let res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildHeaders(credential, request.model),
    body: JSON.stringify(body),
    signal,
  })

  // 4. On 401: refresh token and retry once
  if (res.status === 401) {
    try {
      credential = await refreshCredential(credential)
    } catch {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'Codex 登录已过期，请重新登录', code: 'auth-expired' } },
      }
      return
    }
    res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: buildHeaders(credential, request.model),
      body: JSON.stringify(body),
      signal,
    })
    if (res.status === 401) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'Codex 登录已过期，请重新登录', code: 'auth-expired' } },
      }
      return
    }
  }

  // 5. Update quota from response headers
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => { responseHeaders[key] = value })
  updateQuota(responseHeaders, credential.accountId)

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error('[codex] request failed', res.status, request.model, errBody.slice(0, 200))
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `Codex 请求失败 (${res.status}): ${errBody.slice(0, 100)}`, code: 'http-error' } },
    }
    return
  }

  // 6. Parse stream and yield chunks
  const bodyStream = res.body
  if (bodyStream === null) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'Codex 响应没有 body', code: 'no-body' } },
    }
    return
  }

  // Convert ReadableStream to AsyncIterable<string | Uint8Array>
  const reader = bodyStream.getReader()
  const secrets = [credential.accessToken, credential.refreshToken, credential.accountId].filter((value): value is string => typeof value === 'string')
  const requestId = res.headers.get('x-request-id') ?? res.headers.get('openai-request-id')
  let readFailed = false
  let nextIndex = 0
  let sawToolCall = false
  let active: { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  function* closeBlock(): Generator<ModelStreamChunk> {
    if (active === undefined) return
    yield { type: 'block-end', index: active.index, block: { type: active.type, text: active.text } }
    active = undefined
  }

  async function* toAsyncIterable(): AsyncGenerator<string | Uint8Array> {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() } catch (error) { readFailed = true; throw error }
      const { done, value } = result
      if (done) break
      yield value
    }
  }

  try {
    for await (const event of parseResponsesStream(toAsyncIterable())) {
      switch (event.type) {
        case 'text':
        case 'reasoning': {
          if (active?.type !== event.type) {
            yield* closeBlock()
            active = { index: nextIndex++, type: event.type, text: '' }
            yield { type: 'block-start', index: active.index, blockType: active.type }
          }
          active.text += event.text
          yield { type: event.type === 'text' ? 'text-delta' : 'reasoning-delta', index: active.index, text: event.text }
          break
        }
        case 'tool_call': {
          yield* closeBlock()
          const index = nextIndex++
          sawToolCall = true
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: event.id, name: event.name, argumentsDelta: event.arguments }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: event.id, name: event.name, arguments: event.arguments } }
          break
        }
        case 'finish': {
          yield* closeBlock()
          yield { type: 'finish', reason: { kind: event.reason === 'stop' && sawToolCall ? 'tool-calls' : event.reason } }
          return
        }
        case 'error': {
          yield* closeBlock()
          yield { type: 'finish', reason: { kind: 'error', failure: { message: event.message, code: event.code } } }
          return
        }
      }
    }
  } catch (err) {
    yield* closeBlock()
    const diagnostic = describeError(err, secrets)
    const aborted = signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')
    const category = aborted ? '请求已取消' : err instanceof CodexStreamError ? '流式响应中断' : readFailed ? '响应流读取失败' : '流式响应解析失败'
    const message = `Codex ${category}：${diagnostic.detail}${requestId ? ` (request_id=${redactDiagnostic(requestId, secrets)})` : ''}`
    const code = aborted ? 'ABORTED' : recoveryCode(diagnostic.code) ?? (err instanceof CodexStreamError ? 'TRANSPORT' : 'stream-error')
    // Log the same sanitized facts that are persisted in assistant/attempt.
    // Logging must never replace the original failure with another exception.
    try { console.error('[codex]', message) } catch { /* diagnostic sink unavailable */ }
    yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: { message, code } } }
  } finally {
    reader.releaseLock()
  }
}
