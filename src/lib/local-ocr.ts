import type { OcrLine } from '../shared/types'

export interface LocalOcrOutput {
  text: string
  lines: OcrLine[]
  model: string
}

type PaddleInstance = Awaited<ReturnType<typeof import('@paddleocr/paddleocr-js')['PaddleOCR']['create']>>

let enginePromise: Promise<PaddleInstance> | null = null
let predictionQueue: Promise<void> = Promise.resolve()

function assetUrl(path: string): string {
  return new URL(`/assets/ocr/${path}`, window.location.href).toString()
}

async function engine(): Promise<PaddleInstance> {
  if (!enginePromise) {
    enginePromise = import('@paddleocr/paddleocr-js')
      .then(({ PaddleOCR }) => PaddleOCR.create({
        worker: true,
        textDetectionModelName: 'PP-OCRv6_small_det',
        textDetectionModelAsset: {
          url: assetUrl('models/PP-OCRv6_small_det_onnx_infer.tar')
        },
        textRecognitionModelName: 'PP-OCRv6_small_rec',
        textRecognitionModelAsset: {
          url: assetUrl('models/PP-OCRv6_small_rec_onnx_infer.tar')
        },
        ortOptions: {
          backend: 'wasm',
          wasmPaths: assetUrl('ort/'),
          numThreads: 1,
          simd: true,
          proxy: false
        }
      }))
      .catch((error) => {
        enginePromise = null
        throw error
      })
  }
  return enginePromise
}

function abortError(): DOMException {
  return new DOMException('OCR cancelled', 'AbortError')
}

export function recognizeLocally(image: ImageData, signal?: AbortSignal): Promise<LocalOcrOutput> {
  const run = async (): Promise<LocalOcrOutput> => {
    if (signal?.aborted) throw abortError()
    const instance = await engine()
    if (signal?.aborted) throw abortError()
    const [result] = await instance.predict(image)
    if (signal?.aborted) throw abortError()
    const lines = (result?.items ?? []).flatMap((item): OcrLine[] => {
      const text = item.text.trim()
      if (!text) return []
      return [{
        text,
        score: item.score,
        polygon: item.poly.map(([x, y]) => ({ x, y }))
      }]
    })
    return {
      text: lines.map((line) => line.text).join('\n'),
      lines,
      model: 'PP-OCRv6-small'
    }
  }

  const result = predictionQueue.then(run, run)
  predictionQueue = result.then(() => undefined, () => undefined)
  return result
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成 OCR 图片。')), 'image/png')
  })
}

export function imageDataToBlob(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境无法创建图片画布。')
  context.putImageData(image, 0, 0)
  return canvasToBlob(canvas)
}

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  dispose: () => void
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(blob)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close()
    }
  } catch {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    image.decoding = 'async'
    image.src = objectUrl
    try {
      await image.decode()
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(objectUrl)
      }
    } catch (error) {
      URL.revokeObjectURL(objectUrl)
      throw error
    }
  }
}

export async function rasterizeImageUrl(
  src: string,
  rotation: 0 | 90 | 180 | 270 = 0
): Promise<ImageData> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`无法读取图片（HTTP ${response.status}）。`)
  const decoded = await decodeImage(await response.blob())
  try {
    const maximum = 6_000
    const scale = Math.min(1, maximum / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const swapped = rotation === 90 || rotation === 270
    const canvas = document.createElement('canvas')
    canvas.width = swapped ? height : width
    canvas.height = swapped ? width : height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('当前环境无法创建图片画布。')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate(rotation * Math.PI / 180)
    context.drawImage(decoded.source, -width / 2, -height / 2, width, height)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } finally {
    decoded.dispose()
  }
}

export function rasterizeCanvas(source: HTMLCanvasElement): ImageData {
  const context = source.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('当前环境无法读取 PDF 页面画布。')
  const original = context.getImageData(0, 0, source.width, source.height)
  return new ImageData(new Uint8ClampedArray(original.data), original.width, original.height)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('无法编码 OCR 图片。'))
    reader.onerror = () => reject(reader.error ?? new Error('无法编码 OCR 图片。'))
    reader.readAsDataURL(blob)
  })
}
