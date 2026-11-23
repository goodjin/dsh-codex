import { describe, it, expect } from 'vitest'
import { loadCatalog, BUILTIN_MODELS } from '../src/codex/catalog.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

async function makeTempHome(): Promise<string> {
  return join(tmpdir(), `codex-cat-test-${randomBytes(4).toString('hex')}`)
}

describe('loadCatalog', () => {
  /**
   * 缓存读不出来时给兜底清单，不给空清单。
   *
   * 2026-11-23 现场：Codex CLI 就地改写 models_cache.json，插件读到半截文件时
   * 清单是空的——目录账本随之清空，当前型号从目录里消失，输入框里的强度轴
   * 就没了（宿主把那次选择退回去并报错）。空清单比旧清单坏得多。
   */
  it('falls back to the built-in list when models_cache.json is missing', async () => {
    const home = await makeTempHome()
    const result = await loadCatalog({ home })
    expect(result.map(m => m.id)).toEqual(BUILTIN_MODELS.map(m => m.id))
  })

  it('parses models from models_cache.json', async () => {
    const home = await makeTempHome()
    const codexDir = join(home, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest.', context_window: 500000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], supported_in_api: true, visibility: 'list' },
        { slug: 'gpt-reserve', display_name: 'Reserve', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }], supported_in_api: true, visibility: 'hide' },
      ],
    }))
    const result = await loadCatalog({ home })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('gpt-6.1-sol')
    expect(result[0]!.contextWindow).toBe(500000)
    expect(result[0]!.efforts).toContain('high')
  })

  it('falls back to the built-in list for a malformed cache', async () => {
    const home = await makeTempHome()
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'models_cache.json'), 'not json')
    const result = await loadCatalog({ home })
    expect(result.map(m => m.id)).toEqual(BUILTIN_MODELS.map(m => m.id))
  })
})

describe('BUILTIN_MODELS', () => {
  it('contains verified models from investigation', () => {
    const ids = BUILTIN_MODELS.map(m => m.id)
    expect(ids).toContain('gpt-6.1-sol')
    expect(ids).toContain('gpt-6-astra')
    expect(BUILTIN_MODELS.length).toBeGreaterThanOrEqual(5)
  })

  it('does not offer strengths the endpoint rejects', () => {
    for (const model of BUILTIN_MODELS) {
      expect(model.efforts).not.toContain('ultra')
    }
  })
})
