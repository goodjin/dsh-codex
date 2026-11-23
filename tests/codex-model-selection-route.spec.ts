import { afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 模型清单路由的勾选契约。
 *
 * 设置段靠这三件事成立：GET 报出「勾了哪些 / 是不是自己改的 / 默认是哪一份」，
 * POST 把勾选存下来并让模型行重新发布一份。少一样，勾选就只是画在界面上的。
 */

const catalog = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '旗舰', contextWindow: 500000, efforts: ['low', 'high'] },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, efforts: ['low'] },
]

vi.mock('../src/codex/catalog.ts', () => ({ loadCatalog: async () => catalog }))

type Registered = {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function fakeResponse() {
  const chunks: string[] = []
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) { res.statusCode = status; if (headers) Object.assign(res.headers, headers); return res },
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk) },
    body: () => chunks.join(''),
  }
  return res
}

function fakeRequest(method: string, body = ''): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage
  stream.method = method
  return stream
}

async function loadRoutes(): Promise<Registered[]> {
  const registered: Registered[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn(); return () => {} },
    webServer: { register: (route: Registered) => { registered.push(route); return () => {} } },
    connection: { admit: () => ({ peer: null }) },
  }
  const mod = await import('../src/codex-routes.ts')
  mod.apply(ctx as never)
  return registered
}

describe('codex models route (selection)', () => {
  const homes: string[] = []

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
    vi.resetModules()
  })

  function useTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-route-'))
    homes.push(dir)
    process.env.DSH_HOME = dir
    return dir
  }

  it('GET 报出整份清单、当前勾选与默认那份', async () => {
    useTempHome()
    const routes = await loadRoutes()
    const models = routes.find(r => r.path === '/acp-codex/models')
    expect(models).toBeDefined()
    const res = fakeResponse()
    await models!.handler(fakeRequest('GET'), res as unknown as ServerResponse)
    const body = JSON.parse(res.body()) as { ok: boolean; models: { id: string }[]; selected: string[]; custom: boolean; default: string[] }
    expect(body.ok).toBe(true)
    expect(body.models.map(m => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    // 用户没勾过 → 勾中的就是默认那一份，且不算「自己改过」。
    expect(body.selected).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    expect(body.default).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    expect(body.custom).toBe(false)
  })

  it('POST 存下勾选，之后 GET 报出勾了哪些', async () => {
    const dir = useTempHome()
    const routes = await loadRoutes()
    const models = routes.find(r => r.path === '/acp-codex/models')!

    const post = fakeResponse()
    await models.handler(fakeRequest('POST', JSON.stringify({ ids: ['gpt-6-astra'] })), post as unknown as ServerResponse)
    expect(JSON.parse(post.body())).toMatchObject({ ok: true, selected: ['gpt-6-astra'], custom: true })

    const get = fakeResponse()
    await models.handler(fakeRequest('GET'), get as unknown as ServerResponse)
    const body = JSON.parse(get.body()) as { selected: string[]; custom: boolean; default: string[] }
    expect(body.selected).toEqual(['gpt-6-astra'])
    expect(body.custom).toBe(true)
    expect(body.default).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])

    // 落盘的那一份就是它，重开桌面版还在。
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(dir, 'codex', 'selection.json'), 'utf8')) as { ids: string[] }
    expect(written.ids).toEqual(['gpt-6-astra'])
  })

  it('POST 不带 ids = 回到默认那一份', async () => {
    useTempHome()
    const routes = await loadRoutes()
    const models = routes.find(r => r.path === '/acp-codex/models')!
    await models.handler(fakeRequest('POST', JSON.stringify({ ids: ['gpt-6-astra'] })), fakeResponse() as unknown as ServerResponse)
    await models.handler(fakeRequest('POST', JSON.stringify({})), fakeResponse() as unknown as ServerResponse)
    const get = fakeResponse()
    await models.handler(fakeRequest('GET'), get as unknown as ServerResponse)
    const body = JSON.parse(get.body()) as { selected: string[]; custom: boolean }
    expect(body.selected).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    expect(body.custom).toBe(false)
  })

  it('POST 之后模型行会重新发布一份（勾选立刻进选择器）', async () => {
    useTempHome()
    const published: { presetId: string; models: readonly { id: string }[] }[] = []
    const deps = { onRuntimeModels: (presetId: string, models: readonly { id: string }[]) => { published.push({ presetId, models }) } }
    const { codexModelStream } = await import('../src/codex-model.ts')
    codexModelStream({ presets: { 'acp-codex-global': { agent: 'codex-global' } } }, deps)

    const routes = await loadRoutes()
    const models = routes.find(r => r.path === '/acp-codex/models')!
    await models.handler(fakeRequest('POST', JSON.stringify({ ids: ['gpt-6-astra'] })), fakeResponse() as unknown as ServerResponse)
    // 发布是后台做的，等它落地。
    await new Promise(resolve => setTimeout(resolve, 50))
    const last = published[published.length - 1]
    expect(last?.models.map(m => m.id)).toEqual(['gpt-6-astra'])
  })
})
