import { describe, it, expect } from 'vitest'
import { buildResponsesBody } from '../src/codex/request.ts'
import { resolveImageParts } from '../src/codex-model.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const imageRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }

type Item = { type: string; content?: { type: string; text?: string; image_url?: string }[] }

function itemsOf(body: Record<string, unknown>): Item[] {
  return body.input as Item[]
}

describe('image messages', () => {
  it('turns text + image into input_text + input_image', () => {
    const body = buildResponsesBody({
      model: 'gpt-6.1-terra',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么？' },
          { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
        ],
      }],
    })
    const content = itemsOf(body)[0]!.content!
    expect(content[0]).toEqual({ type: 'input_text', text: '这是什么？' })
    expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' })
  })

  it('does not invent an image part without a resolved data URL', () => {
    const body = buildResponsesBody({
      model: 'gpt-6.1-terra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: imageRef }] }],
    })
    const content = itemsOf(body)[0]!.content!
    expect(content).toEqual([{ type: 'input_text', text: 'hi' }])
  })
})

describe('resolveImageParts', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: imageRef },
    ],
  }]

  it('reads attachment bytes into a data URL', async () => {
    const attachments = { async readImage() { return { data: PNG } } }
    const resolved = await resolveImageParts(messages, { attachmentsOf: () => attachments }, undefined)
    const parts = resolved[0]!.content as { type: string; dataUrl?: string }[]
    expect(parts[1]!.type).toBe('image')
    expect(parts[1]!.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('degrades to a placeholder when the attachment service is missing', async () => {
    const resolved = await resolveImageParts(messages, {}, undefined)
    const parts = resolved[0]!.content as { type: string; text?: string }[]
    expect(parts[1]).toEqual({ type: 'text', text: '[图片无法读取，已省略]' })
  })

  it('degrades to a placeholder when reading throws', async () => {
    const attachments = { async readImage() { throw new Error('boom') } }
    const resolved = await resolveImageParts(messages, { attachmentsOf: () => attachments }, undefined)
    const parts = resolved[0]!.content as { type: string; text?: string }[]
    expect(parts[1]).toEqual({ type: 'text', text: '[图片读取失败，已省略]' })
  })

  it('leaves messages without images untouched', async () => {
    const plain = [{ role: 'user', content: 'hello' }]
    expect(await resolveImageParts(plain, {}, undefined)).toBe(plain)
  })
})
