import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog, API_EFFORTS, BUILTIN_MODELS } from '../src/codex/catalog.ts'
import { codexModelStream } from '../src/codex-model.ts'

/**
 * 强度轴只许摆端点真认的值。
 *
 * 2026-11-23 现场：Codex CLI 写的目录缓存给一半型号标了 `ultra`，而 /responses
 * 端点一律不认，回 400 `invalid_request_error`。选择器把 `ultra` 摆出来，用户
 * 一点就报错，强度也选不上去（宿主把这次改动退回去了）。
 */
describe('强度轴只列端点认的值', () => {
  it('缓存里写了 ultra，也不摆进强度轴', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-effort-'))
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'models_cache.json'), JSON.stringify({
      models: [
        {
          slug: 'gpt-6.2-sol',
          display_name: 'GPT-6.2-Sol',
          visibility: 'list',
          supported_in_api: true,
          context_window: 500000,
          supported_reasoning_levels: [
            { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
            { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
          ],
        },
      ],
    }))

    const catalog = await loadCatalog({ home })
    expect(catalog).toHaveLength(1)
    expect(catalog[0]!.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog[0]!.efforts).not.toContain('ultra')
    expect(catalog[0]!.efforts.every(e => API_EFFORTS.includes(e))).toBe(true)
  })

  it('缓存文件正在被改写时，用兜底清单，别把清单清空', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-effort-'))
    await mkdir(join(home, '.codex'), { recursive: true })
    // 半截的 JSON：Codex CLI 就地改写缓存时可能读到。
    await writeFile(join(home, '.codex', 'models_cache.json'), '{"models":[{"slug":"gpt-6')

    const catalog = await loadCatalog({ home })
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.map(m => m.id)).toEqual(BUILTIN_MODELS.map(m => m.id))
    expect(catalog.every(m => !m.efforts.includes('ultra'))).toBe(true)
  })

  it('缓存文件不在时，用兜底清单', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-effort-'))
    const catalog = await loadCatalog({ home })
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.every(m => !m.efforts.includes('ultra'))).toBe(true)
  })

  it('发布到目录账本的清单带着每个型号自己的强度', async () => {
    const published: { id: string; efforts?: readonly string[] }[][] = []
    const stream = codexModelStream(
      { presets: { 'acp-codex-global': { agent: 'codex-global' } } },
      {
        onRuntimeModels: (_presetId: string, models: readonly { id: string; efforts?: readonly string[] }[]) => {
          published.push([...models])
        },
      },
    )
    // 等首次发布落定。
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stream).toBeTypeOf('function')
    // 这台机器上未必装了 Codex CLI；没装就不该发布空清单。
    for (const batch of published) {
      expect(batch.length).toBeGreaterThan(0)
      for (const model of batch) {
        if (model.efforts !== undefined) expect(model.efforts).not.toContain('ultra')
      }
    }
  })
})
