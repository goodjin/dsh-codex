import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('client wiring', () => {
  it('package.json exports ./client pointing to lib/client.js', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(pkg.exports['./client']).toBeDefined()
    expect(pkg.exports['./client'].default).toContain('lib/client.js')
  })

  it('client index exports name and apply', () => {
    const content = readFileSync(fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)), 'utf8')
    expect(content).toContain('export const name')
    expect(content).toContain('export function apply')
  })

  /**
   * 设置段的三件东西：查授权、刷新模型清单、勾选模型。
   *
   * 2026-11-18 现场：设置段里这三样一起没了，界面不报错，只是「少了几样」——
   * 一整块功能凭空消失，没有任何提示。这里把它们钉住，少一样就红。
   */
  it('设置段带检查授权、刷新模型列表与模型勾选列表', () => {
    const content = readFileSync(fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)), 'utf8')
    expect(content).toContain('检查授权')
    expect(content).toContain('刷新模型列表')
    expect(content).toContain('data-codex-model-check')
    expect(content).toContain('data-codex-models-restore')
    // 勾选要落到宿主：POST 宿主路由，宿主才有地方存。
    expect(content).toContain("method: 'POST'")
    expect(content).toContain("CODEX_MODELS_URL")
  })
})
