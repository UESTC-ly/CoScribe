import { ExternalLink, FileQuestion, FolderSearch } from 'lucide-react'
import { cx, ViewerNotice } from './ViewerChrome'
import type { UnsupportedViewerProps } from './types'

export function UnsupportedViewer({
  fileName = '这个文件',
  extension,
  className,
  detail,
  onReveal,
  onOpenExternal,
}: UnsupportedViewerProps): React.JSX.Element {
  const formatLabel = extension?.replace(/^\./, '').toLocaleUpperCase()
  return (
    <section className={cx('vk-viewer', 'vk-unsupported-viewer', className)} aria-label={`${fileName} 暂不支持`}>
      <ViewerNotice
        icon={<FileQuestion size={34} />}
        title={`暂时无法在应用内预览${formatLabel ? ` ${formatLabel}` : '这种'}文件`}
        detail={
          detail ?? (
            <>
              <strong>{fileName}</strong> 仍保留在项目原位置，未进行任何转换或修改。
              你可以使用系统中的其他应用打开它。
            </>
          )
        }
        actions={
          <>
            {onOpenExternal && (
              <button type="button" className="vk-viewer-primary-action" onClick={onOpenExternal}>
                <ExternalLink size={16} /> 使用其他应用打开
              </button>
            )}
            {onReveal && (
              <button type="button" className="vk-viewer-secondary-action" onClick={onReveal}>
                <FolderSearch size={16} /> 在文件管理器中显示
              </button>
            )}
          </>
        }
      />
    </section>
  )
}
