import guideMarkdown from '../../../resources/guide/CoScribe 使用指南.md?raw'
import { MarkdownViewer } from '../viewers/MarkdownViewer'
import { Dialog } from './Dialog'

interface UserGuideDialogProps {
  onClose: () => void
}

export default function UserGuideDialog({ onClose }: UserGuideDialogProps): React.JSX.Element {
  return (
    <Dialog
      open
      title="CoScribe 使用指南"
      description="内置简明指南；新建项目时也会生成一份可编辑的 Markdown 副本。"
      onClose={onClose}
      width={980}
    >
      <div className="user-guide-content">
        <MarkdownViewer
          value={guideMarkdown}
          documentId="coscribe://guide"
          fileName="CoScribe 使用指南.md"
          mode="preview"
          readOnly
          autoSave={false}
        />
      </div>
    </Dialog>
  )
}
