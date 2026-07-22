import { describe, expect, it, vi } from 'vitest'

const paddle = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@paddleocr/paddleocr-js', () => ({
  PaddleOCR: { create: paddle.create }
}))

import { recognizeLocally } from '../../src/lib/local-ocr'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('local OCR scheduling', () => {
  it('keeps predictions single-flight when a second request starts', async () => {
    const first = deferred<Array<{ items: [] }>>()
    const predict = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([{ items: [] }])
    paddle.create.mockResolvedValue({ predict })

    const firstRequest = recognizeLocally({} as ImageData)
    const secondRequest = recognizeLocally({} as ImageData)
    await vi.waitFor(() => expect(predict).toHaveBeenCalledTimes(1))

    first.resolve([{ items: [] }])
    await firstRequest
    await secondRequest
    expect(predict).toHaveBeenCalledTimes(2)
  })
})
