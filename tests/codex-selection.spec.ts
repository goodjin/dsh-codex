import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 勾选结果：落盘、读回、过滤模型清单。
 *
 * 这些是「设置里勾了哪些模型 → 选择器里就只剩哪些」的底座：
 * 落盘路径不对、读回来是空、过滤时把默认那份也吃掉，用户勾的东西就白勾。
 */
describe('codex model selection', () => {
  const homes: string[] = []

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-selection-'))
    homes.push(dir)
    return dir
  }

  it('没勾过时用默认那一份，一个都不过滤掉', async () => {
    const { applySelection } = await import('../src/codex/selection.ts')
    const models = [{ id: 'a' }, { id: 'b' }]
    expect(applySelection(models, undefined)).toEqual(models)
  })

  it('勾了哪几个就只留哪几个', async () => {
    const { applySelection } = await import('../src/codex/selection.ts')
    expect(applySelection([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'c'])).toEqual([{ id: 'a' }, { id: 'c' }])
  })

  it('一个都没勾就是空清单（用户就是这么选的）', async () => {
    const { applySelection } = await import('../src/codex/selection.ts')
    expect(applySelection([{ id: 'a' }], [])).toEqual([])
  })

  it('保存后落盘到 DSH_HOME/codex/selection.json，读回来一样', async () => {
    const dir = home()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const { saveSelection, loadSelection, currentSelection, resetSelection } = await import('../src/codex/selection.ts')
      await saveSelection(['gpt-6.1-sol'])
      expect(currentSelection()).toEqual(['gpt-6.1-sol'])
      const written = JSON.parse(readFileSync(join(dir, 'codex', 'selection.json'), 'utf8')) as { ids: string[] }
      expect(written.ids).toEqual(['gpt-6.1-sol'])
      // 重新读一遍（模拟重启）：勾选还在。
      await resetSelection()
      expect(currentSelection()).toBeUndefined()
      await saveSelection(['gpt-6.1-sol'])
      await loadSelection()
      expect(currentSelection()).toEqual(['gpt-6.1-sol'])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('恢复默认把落盘文件删掉', async () => {
    const dir = home()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const { saveSelection, resetSelection, currentSelection } = await import('../src/codex/selection.ts')
      await saveSelection(['x'])
      await resetSelection()
      expect(currentSelection()).toBeUndefined()
      expect(() => readFileSync(join(dir, 'codex', 'selection.json'), 'utf8')).toThrow()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
