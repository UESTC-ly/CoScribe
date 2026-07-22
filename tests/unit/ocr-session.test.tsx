import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiOcrRequest, OcrResult } from '../../src/shared/types'

const localOcr = vi.hoisted(() => ({
  recognizeLocally: vi.fn(),
  imageDataToBlob: vi.fn(),
  blobToDataUrl: vi.fn()
}))

vi.mock('../../src/lib/local-ocr', () => localOcr)

import { useOcrSession } from '../../src/components/viewers/useOcrSession'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const resultValue: OcrResult = {
  path: '/project/scan.pdf',
  page: 1,
  text: 'old page',
  lines: [],
  engine: 'ai-vision',
  model: 'mock-model',
  createdAt: 1,
  sourceModifiedAt: 1,
  sourceSize: 1
}

function installOcrApi(enhance = vi.fn(async (_request: AiOcrRequest) => resultValue)) {
  const ocr = {
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn(async (value: OcrResult) => value),
    enhance,
    stop: vi.fn().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'coscribe', {
    configurable: true,
    value: { ocr }
  })
  return ocr
}

describe('OCR session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localOcr.imageDataToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    localOcr.blobToDataUrl.mockResolvedValue('data:image/png;base64,aW1hZ2U=')
  })

  it('invalidates a local result when cleanup aborts its cooperative signal', async () => {
    const ocr = installOcrApi()
    const pending = deferred<{ text: string; lines: []; model: string }>()
    let observedSignal: AbortSignal | undefined
    localOcr.recognizeLocally.mockImplementation(async (_image: ImageData, signal?: AbortSignal) => {
      observedSignal = signal
      const value = await pending.promise
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      return value
    })
    const { result } = renderHook(() => useOcrSession({
      path: '/project/image.png',
      getImage: vi.fn().mockResolvedValue({} as ImageData)
    }))
    await waitFor(() => expect(ocr.get).toHaveBeenCalled())

    let request!: Promise<void>
    act(() => { request = result.current.runLocal() })
    await waitFor(() => expect(result.current.status).toBe('local'))
    act(() => result.current.cancel())
    pending.resolve({ text: 'ignored', lines: [], model: 'mock' })
    await act(async () => request)

    expect(observedSignal?.aborted).toBe(true)
    expect(result.current.status).toBe('idle')
    expect(ocr.save).not.toHaveBeenCalled()
  })

  it('stops an AI request and resets busy state when the PDF page changes', async () => {
    const pending = deferred<OcrResult>()
    const enhance = vi.fn((_request: AiOcrRequest) => pending.promise)
    const ocr = installOcrApi(enhance)
    const getImage = vi.fn().mockResolvedValue({} as ImageData)
    const { result, rerender } = renderHook(
      ({ page }) => useOcrSession({ path: '/project/scan.pdf', page, getImage }),
      { initialProps: { page: 1 } }
    )
    await waitFor(() => expect(ocr.get).toHaveBeenCalledWith('/project/scan.pdf', 1))

    let request!: Promise<void>
    act(() => { request = result.current.runAi() })
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(1))
    const requestId = enhance.mock.calls[0][0].requestId
    rerender({ page: 2 })

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(ocr.stop).toHaveBeenCalledWith(requestId)
    expect(ocr.get).toHaveBeenCalledWith('/project/scan.pdf', 2)

    pending.resolve(resultValue)
    await act(async () => request)
    expect(result.current.result).toBeNull()
  })

  it('stops an active AI request when the viewer unmounts', async () => {
    const pending = deferred<OcrResult>()
    const enhance = vi.fn((_request: AiOcrRequest) => pending.promise)
    const ocr = installOcrApi(enhance)
    const { result, unmount } = renderHook(() => useOcrSession({
      path: '/project/scan.pdf',
      page: 1,
      getImage: vi.fn().mockResolvedValue({} as ImageData)
    }))
    await waitFor(() => expect(ocr.get).toHaveBeenCalled())

    let request!: Promise<void>
    act(() => { request = result.current.runAi() })
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(1))
    const requestId = enhance.mock.calls[0][0].requestId
    unmount()

    expect(ocr.stop).toHaveBeenCalledWith(requestId)
    pending.resolve(resultValue)
    await request
  })
})
