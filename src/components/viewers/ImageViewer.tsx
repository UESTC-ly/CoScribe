import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Expand,
  ExternalLink,
  ImageOff,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  ScanText,
  Sparkles,
} from 'lucide-react'
import { rasterizeImageUrl } from '../../lib/local-ocr'
import { cx, IconButton, ToolbarDivider, ViewerNotice, ViewerSpinner } from './ViewerChrome'
import { OcrPanel } from './OcrPanel'
import type { ImageViewerProps, ImageViewerState } from './types'
import { useOcrSession } from './useOcrSession'

const IMAGE_MIN_SCALE = 0.1
const IMAGE_MAX_SCALE = 8

function clampScale(scale: number): number {
  return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, Math.round(scale * 10) / 10))
}

export function ImageViewer({
  src,
  filePath,
  sourceModifiedAt,
  sourceSize,
  alt,
  fileName = '图片',
  className,
  initialState,
  onStateChange,
  onLoad,
  onError,
  onOpenExternal,
  onOcrTextChange,
}: ImageViewerProps): React.JSX.Element {
  const [scale, setScale] = useState(clampScale(initialState?.scale ?? 1))
  const [rotation, setRotation] = useState<ImageViewerState['rotation']>(initialState?.rotation ?? 0)
  const [fit, setFit] = useState(initialState?.fit ?? true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const getOcrImage = useCallback(() => rasterizeImageUrl(src, rotation), [rotation, src])
  const ocr = useOcrSession({
    path: filePath,
    sourceModifiedAt,
    sourceSize,
    getImage: getOcrImage,
    onResult: (result) => onOcrTextChange?.(result?.text ?? '')
  })

  useEffect(() => {
    setLoading(true)
    setError(null)
    setNaturalSize(null)
    setScale(clampScale(initialState?.scale ?? 1))
    setRotation(initialState?.rotation ?? 0)
    setFit(initialState?.fit ?? true)
  }, [src])

  useEffect(() => {
    onStateChange?.({ scale, rotation, fit })
  }, [fit, onStateChange, rotation, scale])

  const changeScale = useCallback((nextScale: number) => {
    setFit(false)
    setScale(clampScale(nextScale))
  }, [])

  const rotate = useCallback((direction: 1 | -1) => {
    setRotation((current) => ((current + direction * 90 + 360) % 360) as ImageViewerState['rotation'])
  }, [])

  return (
    <section className={cx('vk-viewer', 'vk-image-viewer', className)} aria-label={`${fileName} 图片查看器`}>
      <header className="vk-viewer-toolbar">
        <div className="vk-viewer-toolbar-group">
          <IconButton label="向左旋转" onClick={() => rotate(-1)}>
            <RotateCcw size={17} />
          </IconButton>
          <IconButton label="向右旋转" onClick={() => rotate(1)}>
            <RotateCw size={17} />
          </IconButton>
          <ToolbarDivider />
          <IconButton label="本地文字识别" active={ocr.panelOpen && ocr.result?.engine === 'paddleocr-v6'} onClick={() => void ocr.runLocal()}>
            <ScanText size={17} />
          </IconButton>
          <IconButton label="AI 增强识别（发送当前图像）" active={ocr.panelOpen && ocr.result?.engine === 'ai-vision'} onClick={() => void ocr.runAi()}>
            <Sparkles size={17} />
          </IconButton>
          <ToolbarDivider />
          <IconButton label="缩小" onClick={() => changeScale(scale - 0.1)}>
            <Minus size={17} />
          </IconButton>
          <button
            type="button"
            className="vk-image-scale-value"
            onClick={() => changeScale(1)}
            title="恢复 100%"
          >
            {fit ? '适应窗口' : `${Math.round(scale * 100)}%`}
          </button>
          <IconButton label="放大" onClick={() => changeScale(scale + 0.1)}>
            <Plus size={17} />
          </IconButton>
          <button
            type="button"
            className={cx('vk-viewer-text-button', fit && 'is-active')}
            onClick={() => setFit(true)}
          >
            <Expand size={15} /> 适应窗口
          </button>
        </div>
        <div className="vk-viewer-toolbar-group vk-image-meta">
          {naturalSize && <span>{naturalSize.width} × {naturalSize.height}</span>}
          {onOpenExternal && (
            <button type="button" className="vk-viewer-text-button" onClick={onOpenExternal}>
              <ExternalLink size={15} /> 外部打开
            </button>
          )}
        </div>
      </header>

      <div className="vk-image-body">
        <div
          ref={scrollRef}
          className={cx('vk-image-stage', fit && 'is-fit')}
          tabIndex={0}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            changeScale(scale + (event.deltaY < 0 ? 0.1 : -0.1))
          }}
        >
        {loading && !error && <ViewerSpinner label="正在载入图片…" />}
        {error ? (
          <ViewerNotice
            icon={<ImageOff size={30} />}
            title="无法显示这张图片"
            detail={error.message}
            actions={
              onOpenExternal && (
                <button type="button" className="vk-viewer-primary-action" onClick={onOpenExternal}>
                  使用其他应用打开
                </button>
              )
            }
            tone="danger"
          />
        ) : (
          <img
            src={src}
            alt={alt || fileName}
            className={cx(loading && 'is-loading')}
            style={
              fit
                ? { transform: `rotate(${rotation}deg)` }
                : {
                    width: naturalSize ? naturalSize.width * scale : undefined,
                    height: naturalSize ? naturalSize.height * scale : undefined,
                    transform: `rotate(${rotation}deg)`,
                  }
            }
            onLoad={(event) => {
              const size = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              }
              setNaturalSize(size)
              setLoading(false)
              onLoad?.(size)
            }}
            onError={() => {
              const nextError = new Error('图片文件可能已损坏、移动，或使用了当前不支持的编码。')
              setLoading(false)
              setError(nextError)
              onError?.(nextError)
            }}
          />
        )}
        </div>
        {ocr.panelOpen && (
          <OcrPanel
            result={ocr.result}
            status={ocr.status}
            error={ocr.error}
            onLocal={() => void ocr.runLocal()}
            onAi={() => void ocr.runAi()}
            onCancel={ocr.cancel}
            onClose={() => ocr.setPanelOpen(false)}
          />
        )}
      </div>
    </section>
  )
}
