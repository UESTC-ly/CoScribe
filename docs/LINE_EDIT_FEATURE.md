# Line Edit Feature for propose_workspace_operation

> 核对基线：2026-08-23，`package.json` 版本 `4.0.5`。本文以 `src/shared/types.ts`、`electron/main/project.ts`、`electron/main/line-edits.ts`、`src/lib/file-operations.ts` 和对应测试为事实源。

## 概述

AI 工具 `propose_workspace_operation` 支持 `edit` 操作类型，用于对 Markdown、代码和普通文本文件做行级修改。模型仍可以使用 `replace` 做整文件改写；当模型把不可用的行级编辑标成 `edit`，但同时提供了整文件 `proposedContent`，主进程会把该提议降级为 `replace` 预览。

所有 AI 文件写入仍遵守同一条安全链路：模型只产生结构化提议，Renderer 展示内容或差异预览及确认卡片，主进程在写入前重新验证项目路径、符号链接、mtime、完整内容和用户确认的 pending 提议。

## 类型契约

当前共享类型定义在 `src/shared/types.ts`：

```typescript
export type FileOperationKind = 'create' | 'append' | 'replace' | 'edit'

export interface LineEdit {
  startLine: number
  endLine: number
  newContent: string
}

export interface TextFileOperation {
  kind: FileOperationKind
  targetPath: string
  proposedContent?: string
  edits?: LineEdit[]
  originalContent?: string
  diskContent?: string
  baseSource?: 'disk' | 'buffer'
  expectedModifiedAt?: number
}

export interface FileOperationProposal extends TextFileOperation {
  id: string
  operations?: TextFileOperation[]
  summary: string
  status: 'pending' | 'accepted' | 'rejected' | 'failed'
  error?: string
}
```

`MarkdownFileOperation` 只是为 v3 历史记录保留的兼容别名，当前通用文本操作类型是 `TextFileOperation`。

## 使用示例

### 修改单行

```typescript
{
  kind: 'edit',
  targetPath: 'src/utils.ts',
  edits: [
    {
      startLine: 10,
      endLine: 10,
      newContent: 'function getUsername(id: string) {'
    }
  ]
}
```

### 删除多行

```typescript
{
  kind: 'edit',
  targetPath: 'config.json',
  edits: [
    {
      startLine: 15,
      endLine: 18,
      newContent: ''
    }
  ]
}
```

### 多处修改

```typescript
{
  kind: 'edit',
  targetPath: 'README.md',
  edits: [
    {
      startLine: 5,
      endLine: 5,
      newContent: '## 项目简介\n\n这是一个学习项目。'
    },
    {
      startLine: 23,
      endLine: 25,
      newContent: '## 贡献指南\n\n欢迎提交 PR。'
    }
  ]
}
```

## 实现细节

### `applyLineEdits(originalContent, edits)`

- 位置：`electron/main/line-edits.ts`
- `src/lib/file-operations.ts` 还保留一份供纯逻辑安全预览测试使用的同等实现 `applyLineEditsClient()`；当前聊天确认卡片在 `src/components/ai/MarkdownOperationCard.tsx` 中渲染实际预览。
- 行号为 1-based，`endLine` 为包含端点。
- `newContent: ''` 表示删除行；多行内容用 `\n` 分隔。
- 编辑按从后向前应用，避免前面的修改导致后续行号偏移。
- 空 `edits` 数组在底层应用函数中返回原文，但不会被主进程当作有效 `edit` 提议。

### `normalizeLineEdits(value)`

- 位置：`electron/main/line-edits.ts`
- 只接受非空数组，且每个元素都必须满足：
  - `startLine` 是整数；
  - `endLine` 是整数；
  - `newContent` 是字符串。
- 返回 `LineEdit[]` 或 `null`。`project.ts` 用它对不可信模型输出做结构归一化；行号范围、排序和重叠仍由随后调用的 `applyLineEdits()` 校验。

### `validateEditOperation(operation)`

- 位置：`electron/main/line-edits.ts`
- 当前主要由单元测试覆盖字段兼容契约，不是 `ProjectService.prepareAiOperation()` 的生产入口。
- 规则是宽松的：`edit` 需要有效 `edits`；`create`、`append`、`replace` 需要字符串 `proposedContent`。多余字段不会导致失败。

### 主进程提议准备

`electron/main/project.ts` 中的 `prepareAiOperation()` 是生产入口：

- 支持 `create`、`append`、`replace`、`edit`。
- `edit` 同时带 `edits` 和 `proposedContent` 时，`edits` 优先；主进程用行编辑基于磁盘或冻结 IDE 缓冲区计算最终 `proposedContent`，供差异预览和确认一致性校验使用。
- 非 `edit` 操作多带 `edits` 时，主进程忽略多余 `edits`。
- `edit` 的 `edits` 不可用但 `proposedContent` 是字符串时，提议会降级为 `replace`。
- `edit` 既没有可用 `edits`，也没有可降级的 `proposedContent` 时，抛出 `AI edit 操作缺少有效的 edits 数组。`
- 目标只允许项目内可编辑的 Markdown、代码或文本文件。

## 边界情况处理

`applyLineEdits()` 会检查：

1. `startLine >= 1`
2. `endLine >= startLine`
3. `startLine` 和 `endLine` 均不超过文件总行数
4. `edits` 按 `startLine` 升序排列
5. 编辑范围不重叠；相邻但不重叠的编辑允许

当前主进程错误文本包括：

- `起始行号必须 >= 1，实际为 X`
- `结束行号 Y 不能小于起始行号 X`
- `起始行号 X 超出文件范围（共 N 行）`
- `结束行号 Y 超出文件范围（共 N 行）`
- `编辑列表必须按起始行号升序排列`
- `编辑范围重叠：第 N 个编辑 (X-Y) 与第 M 个编辑 (A-B) 冲突`

如果文件在预览后被修改，确认写入会拒绝并提示：`文件在预览后已被修改。请重新加载并生成新的修改建议。`

## 字段兼容性

- 现有 `create`、`append`、`replace` 操作继续使用 `proposedContent`。
- `edit` 推荐只发送 `edits`，但同时发送 `proposedContent` 也会被接受；最终以 `edits` 计算结果为准。
- 非 `edit` 操作带多余 `edits` 不会失败。
- 不可用 `edit` 加字符串 `proposedContent` 会按整文件 `replace` 处理。
- `src/lib/file-operations.ts` 是仍只允许 Markdown 目标的纯逻辑安全预览工具；当前聊天中的生产确认卡片是 `src/components/ai/MarkdownOperationCard.tsx`，主进程操作边界允许 Markdown、代码和文本文件。

## 测试覆盖

当前测试覆盖以源码内测试文件和 `npm test` 输出为准：

- `electron/main/line-edits.test.ts`：24 个测试用例，覆盖应用、规范化和字段兼容验证。
- `electron/main/project-ai-operations.test.ts`：覆盖同时携带 `edits`/`proposedContent`、无效 `edit` 降级 `replace`、越界拒绝、未保存 IDE 缓冲区基线和代码/文本文件操作。
- `npm test` 当前分组结果：unit 29 文件/111 项，Electron 24 文件/193 项，AI 组件 3 文件/38 项，合计 342 项。

## AI 模型使用指南

### 何时使用 `edit`

- 修改少量明确行号的内容；
- 删除特定行范围；
- 用“原行 + 新内容”替换某一行来实现插入，且能可靠定位行号；当前协议没有零宽度插入范围。

### 何时使用 `replace`

- 文件需要大范围重构；
- 修改涉及大部分行；
- 模型无法可靠定位行号；
- 希望显式提交完整新文件内容。

### 注意事项

1. 行号是 1-based，第一行是 1。
2. `edits` 必须按 `startLine` 升序排列。
3. 编辑范围不能重叠。
4. `edit` 可带 `proposedContent` 作为整文件降级信息，但正常路径中 `edits` 优先。
5. 文件写入不会因为模型提议而静默发生，必须经过用户确认和主进程重新校验。

## 后续优化方向

1. 智能合并：多个小范围编辑自动合并为更易读的预览。
2. 冲突解决：提供三方合并界面处理预览后的外部修改。
3. 性能优化：大文件懒加载和增量 diff。

## 相关文件

- `src/shared/types.ts` - 类型定义
- `electron/main/line-edits.ts` - 主进程行编辑核心逻辑
- `electron/main/line-edits.test.ts` - 行编辑单元测试
- `electron/main/project.ts` - AI 文件提议准备、确认写入和撤销
- `electron/main/project-ai-operations.test.ts` - 主进程 AI 文件操作集成测试
- `electron/main/ai.ts` - AI 工具 schema 和模型响应处理
- `src/lib/file-operations.ts` - Markdown-only 的纯逻辑安全预览工具及测试入口
- `src/components/ai/MarkdownOperationCard.tsx` - 文件操作确认卡片

## 版本信息

- 添加日期：2026-08-11
- 最近核对：2026-08-23
- 版本：4.0.5
- 功能状态：已完成并由当前测试覆盖
