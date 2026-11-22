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
import { updateQuota } from './codex/quota.ts'

/** 运行时清单写进目录账本时用的形状。 */
export type CodexReportedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly contextWindow?: number | undefined
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
 */
export async function refreshCodexModels(): Promise<void> {
  const catalog = await loadCatalog()
  const reported: CodexReportedModel[] = catalog.map(m => ({
    id: m.id,
    name: m.name,
    ...(m.description === undefined ? {} : { description: m.description }),
    contextWindow: m.contextWindow,
  }))
  for (const publish of publishers.values()) {
    publish(reported)
  }
}

/** 读图片附件所需的最小接口（宿主 `attachments` 服务的子集）。 */
export type AttachmentsReader = {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ data?: Uint8Array } | Uint8Array>
}

type StreamDeps = {
  onRuntimeModels?: (presetId: string, models: readonly CodexReportedModel[]) => void
  attachmentsOf?: () => AttachmentsReader | undefined
}

/** 单张图片 base64 上限；超过就不发，避免整轮请求被判过大。 */
const MAX_IMAGE_BASE64 = 20 * 1024 * 1024

function logImage(line: string): void {
  try { console.error(line) } catch { /* logging must never break a request */ }
}

/**
 * 把消息里的图片附件读成 data URL。
 *
 * DSH 的图片内容块只带 attachment 引用，而 Codex /responses 要的是可读的
 * `input_image`。读不到就降级成占位文本，既不静默丢图，也不让整轮失败。
 */
export async function resolveImageParts(
  messages: readonly { role: string; content: unknown }[],
  deps: StreamDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<{ role: string; content: unknown }[]> {
  const hasImage = messages.some(m => Array.isArray(m.content)
    && (m.content as unknown[]).some(p => p !== null && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'image'))
  if (!hasImage) return messages as { role: string; content: unknown }[]

  let attachments: AttachmentsReader | undefined
  try { attachments = deps?.attachmentsOf?.() } catch { attachments = undefined }

  const resolved: { role: string; content: unknown }[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      resolved.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const part of message.content as unknown[]) {
      const p = part as Record<string, unknown> | null
      if (p === null || typeof p !== 'object' || p['type'] !== 'image') {
        parts.push(part)
        continue
      }
      const ref = (p['attachment'] ?? (p['value'] as Record<string, unknown> | undefined)?.['attachment'] ?? p) as Record<string, unknown>
      const mediaType = typeof ref['mediaType'] === 'string' ? ref['mediaType'] : 'image/png'
      if (attachments === undefined || typeof attachments.readImage !== 'function') {
        logImage('[codex] image dropped: attachment service unavailable')
        parts.push({ type: 'text', text: '[图片无法读取，已省略]' })
        continue
      }
      try {
        const result = await attachments.readImage(ref, signal)
        const bytes = result instanceof Uint8Array ? result : result?.data
        if (bytes === undefined) throw new Error('附件读取没有返回字节')
        const base64 = Buffer.from(bytes).toString('base64')
        if (base64.length > MAX_IMAGE_BASE64) throw new Error('图片超过 20MB')
        parts.push({ type: 'image', mediaType, dataUrl: `data:${mediaType};base64,${base64}` })
      } catch (error) {
        logImage(`[codex] image read failed: ${error instanceof Error ? error.message : String(error)}`)
        parts.push({ type: 'text', text: '[图片读取失败，已省略]' })
      }
    }
    resolved.push({ role: message.role, content: parts })
  }
  return resolved
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
        const reported: CodexReportedModel[] = catalog.map(m => ({
          id: m.id,
          name: m.name,
          ...(m.description === undefined ? {} : { description: m.description }),
          contextWindow: m.contextWindow,
        }))
        deps.onRuntimeModels!(presetId, reported)
      }).catch(() => {})
    }
  }

  return (presetId: string, request: ModelTurnRequest): AsyncGenerator<ModelStreamChunk> | undefined => {
    const preset = config.presets[presetId]
    if (preset === undefined || preset.agent !== 'codex-global') return undefined

    return streamWithDiagnostics(presetId, request, deps)
  }
}

/** One attempt only: the host owns retry delays, attempt persistence and cancellation. */
async function* streamWithDiagnostics(
  presetId: string,
  request: ModelTurnRequest,
  deps: StreamDeps | undefined,
): AsyncGenerator<ModelStreamChunk> {
  try { yield* streamCodex(presetId, request, deps) }
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
  deps: StreamDeps | undefined,
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
  const messages = await resolveImageParts(
    (request.messages ?? []) as { role: string; content: unknown }[],
    deps,
    request.signal as AbortSignal | undefined,
  ) as { role: string; content: string }[]
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
