import { describe, expect, it } from 'vitest'
import { modelRowAdapter } from '../src/modelkit/model-row-adapter.ts'

const provider = 'acp:codex'
describe('model capability consistency', () => {
  it('preserves reasoning and context for bare IDs at list, resolve, and prepare', async () => {
    const adapter = modelRowAdapter({
      presetId: 'codex', displayName: 'Codex',
      declaredModels: [{ id: 'test', name: 'Test', contextWindow: 272000 }],
      efforts: [{ id: 'low' }, { id: 'high' }],
    })
    const [listed] = await adapter.listModels(provider)
    expect(listed?.reasoning?.efforts.map(e => e.id)).toEqual(['low', 'high'])
    expect(listed?.reasoning).not.toHaveProperty('defaultEffort')
    expect(await adapter.resolveModel(provider, 'test')).toEqual(listed)
    expect((await adapter.prepareCall(provider, 'test')).model).toEqual(listed)
    expect(listed?.context?.contextWindow).toBe(272000)
  })

  it('keeps explicit effort unchanged during dispatch', async () => {
    const seen: unknown[] = []
    const adapter = modelRowAdapter({
      presetId: 'codex', displayName: 'Codex', declaredModels: [{ id: 'test', name: 'Test' }],
      efforts: [{ id: 'low' }, { id: 'high' }],
      modelStream: (_id, request) => (async function* () { seen.push(request); yield { type: 'finish', reason: { kind: 'stop' } } as const })(),
    })
    const call = await adapter.prepareCall(provider, 'test')
    for (const reasoningEffort of ['low', 'high', undefined]) {
      const request = { provider, model: 'test', ...(reasoningEffort ? { reasoningEffort } : {}) }
      for await (const _ of call.stream(request)) { /* drain */ }
      expect(seen.at(-1)).toEqual(request)
    }
  })

  it('uses the strengths a runtime model reports, not the declared list', async () => {
    // 运行时清单报了自己支持的强度，就按它画轴：声明那份是兜底，不是上限。
    const adapter = modelRowAdapter({
      presetId: 'codex', displayName: 'Codex',
      declaredModels: [{ id: 'luna', name: 'Luna' }],
      runtimeModelsOf: () => [{ id: 'luna', name: 'Luna', efforts: ['low', 'high'] }],
      efforts: [{ id: 'low' }, { id: 'high' }, { id: 'ultra' }],
    })
    const [listed] = await adapter.listModels(provider)
    expect(listed?.reasoning?.efforts.map(e => e.id)).toEqual(['low', 'high'])
  })
})
