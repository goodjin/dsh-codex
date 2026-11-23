/**
 * Codex 宿主路由：会话状态、模型清单、登录。
 *
 * GET /acp-codex/session → 登录状态
 * GET /acp-codex/models → 模型清单 + 用户勾了哪些
 * POST /acp-codex/models → 保存用户勾选的模型
 * POST /acp-codex/login → 启动 OAuth 登录流程（PKCE）
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadCredential } from './codex/auth.ts'
import { loadCatalog } from './codex/catalog.ts'
import { startCodexLogin } from './codex/login.ts'
import { currentSelection, resetSelection, saveSelection } from './codex/selection.ts'
import { refreshCodexModels } from './codex-model.ts'

export const name = 'acp-codex-routes'
export const inject = ['webServer', 'connection']

type RouteContext = {
  effect: (fn: () => unknown) => unknown
  webServer: {
    register: (route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) => (() => void) | void
  }
  connection: {
    admit: (req: IncomingMessage) => { rejection: number } | { peer: unknown }
  }
}

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * 注册 Codex 宿主路由。
 */
export function apply(ctx: RouteContext): void {
  ctx.effect(() => {
    // GET /acp-codex/session — 登录状态
    ctx.webServer.register({
      kind: 'exact',
      path: '/acp-codex/session',
      async handler(req, res) {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
        if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end('method not allowed'); return }
        try {
          const cred = await loadCredential()
          send(res, { ok: true, signedIn: cred !== undefined })
        } catch {
          send(res, { ok: false, error: '读取凭据失败' })
        }
      },
    })

    // GET/POST /acp-codex/models — 模型清单与用户勾选
    ctx.webServer.register({
      kind: 'exact',
      path: '/acp-codex/models',
      async handler(req, res) {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
        if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end('method not allowed'); return }
        try {
          const catalog = await loadCatalog()
          const models = catalog.map(m => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            efforts: m.efforts,
          }))
          const all = models.map(m => m.id)

          if (req.method === 'POST') {
            // 勾选只改「选择器里显示哪几个」，不影响模型能不能被请求。
            const body = await readIds(req)
            // 空数组 = 一个都不选；没有 ids 字段 = 回到默认那一份。
            const ids = body.ids
            if (ids === undefined) await resetSelection()
            else await saveSelection(ids)
            // 勾选只失效发布状态，模型清单本身继续用上游那份。
            // 后台重新发布勾选子集：响应不等待，失败也不影响「已保存」。
            void refreshCodexModels().catch(() => {})
            send(res, { ok: true, selected: ids ?? all, custom: ids !== undefined })
            return
          }

          // GET：整份清单 + 用户勾了哪些 + 默认那一份（设置段据此画勾选列表）。
          const stored = currentSelection()
          send(res, {
            ok: true,
            models,
            selected: stored ?? all,
            custom: stored !== undefined,
            default: all,
          })
        } catch {
          send(res, { ok: false, error: '读取模型清单失败' })
        }
      },
    })

    // POST /acp-codex/login — 启动 OAuth 登录
    ctx.webServer.register({
      kind: 'exact',
      path: '/acp-codex/login',
      async handler(req, res) {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end('method not allowed'); return }
        try {
          const { url } = await startCodexLogin()
          send(res, { ok: true, url })
        } catch (err) {
          send(res, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    })
  })
}

/**
 * 读请求体里的勾选结果。
 *
 * 两种意思：带 `ids` 数组 = 勾成这些；不带 = 回到默认那一份。
 * @param req - 请求。
 * @returns 勾选的 id；没带 `ids` 字段是 `undefined`。
 */
async function readIds(req: IncomingMessage): Promise<{ ids?: string[] }> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const ids = (parsed as { ids?: unknown }).ids
    if (!Array.isArray(ids)) return {}
    return { ids: ids.filter((id): id is string => typeof id === 'string' && id !== '') }
  } catch {
    return {}
  }
}
