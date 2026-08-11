# Line Edit Feature for propose_workspace_operation

## 概述

为 AI 工具 `propose_workspace_operation` 增加了 `edit` 操作类型，支持精确的行级文件修改。之前修改文件中的几行需要使用 `replace` 重写整个文件，现在可以通过 `edit` 操作指定具体的行范围进行修改。

## 类型定义

### LineEdit 接口

```typescript
interface LineEdit {
  startLine: number   // 1-based，要修改的起始行
  endLine: number     // 1-based，要修改的结束行（包含）
  newContent: string  // 替换后的内容（可以是多行，用 \n 分隔）
}
```

### 扩展的 WorkspaceOperation

```typescript
interface WorkspaceOperation {
  kind: "create" | "append" | "replace" | "edit"
  targetPath: string
  
  // 用于 create/append/replace
  proposedContent?: string
  
  // 用于 edit（局部修改）
  edits?: Array<LineEdit>
}
```

## 使用示例

### 修改单行

```typescript
{
  kind: "edit",
  targetPath: "src/utils.ts",
  edits: [
    {
      startLine: 10,
      endLine: 10,
      newContent: "function getUsername(id: string) {"
    }
  ]
}
```

### 删除多行

```typescript
{
  kind: "edit",
  targetPath: "config.json",
  edits: [
    {
      startLine: 15,
      endLine: 18,
      newContent: ""  // 空字符串表示删除
    }
  ]
}
```

### 多处修改

```typescript
{
  kind: "edit",
  targetPath: "README.md",
  edits: [
    {
      startLine: 5,
      endLine: 5,
      newContent: "## 项目简介\n\n这是一个学习项目。"
    },
    {
      startLine: 23,
      endLine: 25,
      newContent: "## 贡献指南\n\n欢迎提交 PR。"
    }
  ]
}
```

## 实现细节

### 核心函数

#### `applyLineEdits(originalContent: string, edits: LineEdit[]): string`

- 位置：`electron/line-edits.ts` 和 `src/lib/file-operations.ts`（客户端版本）
- 功能：将多个行编辑应用到原始内容上
- 验证逻辑：
  - 行号必须在有效范围内（1 到文件总行数）
  - `edits` 数组必须按 `startLine` 升序排列
  - 编辑范围不能重叠
- 应用策略：从后向前应用编辑，避免行号偏移

#### `validateEditOperation(operation)`

- 位置：`electron/line-edits.ts`
- 功能：验证操作的字段一致性
- 规则：
  - `edit` 操作必须有非空的 `edits` 数组，不应有 `proposedContent`
  - 其他操作（`create`/`append`/`replace`）必须有 `proposedContent`，不应有 `edits`

### 修改的文件

#### 类型定义
- `src/shared/types.ts`
  - 添加 `LineEdit` 接口
  - 扩展 `FileOperationKind` 类型，添加 `'edit'`
  - `FileOperationProposal` 的 `proposedContent` 变为可选
  - 添加可选的 `edits` 字段

#### 主进程逻辑
- `electron/line-edits.ts` (新建)
  - `applyLineEdits()` - 服务端行编辑应用
  - `validateEditOperation()` - 操作字段验证
- `electron/line-edits.test.ts` (新建)
  - 28 个测试用例，覆盖各种场景
- `electron/main/project.ts`
  - 导入 `applyLineEdits` 和 `validateEditOperation`
  - 在 `applyAiOperation` 中添加字段验证
  - 在操作应用逻辑中处理 `edit` 类型
- `electron/main/ai.ts`
  - 更新 AI 工具 schema，添加 `'edit'` 到 `kind` 枚举
  - 添加 `edits` 数组定义到工具参数
  - 使 `proposedContent` 在 schema 中可选

#### 渲染进程逻辑
- `src/lib/file-operations.ts`
  - 添加客户端版本的 `applyLineEditsClient()`
  - 更新 `validateFileOperation()` 接受 `edits` 字段
  - 更新 `describeFileOperationIntent()` 处理 `edit` 类型
  - 更新 `buildFileOperationPreview()` 生成 edit 操作的 diff
- `src/components/ai/MarkdownOperationCard.tsx`
  - 处理 `proposedContent` 可能为 `undefined` 的情况
  - 计算 `edit` 操作的 diff 预览

## 边界情况处理

### 验证规则
1. **行号范围**：`startLine >= 1` 且 `endLine <= 文件总行数`
2. **行号顺序**：`startLine <= endLine`
3. **编辑排序**：`edits` 数组必须按 `startLine` 升序排列
4. **无重叠**：后一个编辑的 `startLine` 必须 > 前一个编辑的 `endLine`

### 错误信息
- `起始行号必须 >= 1，实际: X`
- `结束行号不能小于起始行号: X-Y`
- `行号超出文件范围（共 N 行）: X-Y`
- `编辑列表必须按起始行号升序排列`
- `编辑范围重叠: 第 N 个编辑 (X-Y) 与前一个编辑 (A-B)`

### 文件冲突检测
操作应用前会检查：
- 文件的 `modifiedAt` 时间戳是否匹配
- 文件内容是否与预期一致（通过 `diskContent` 或 `originalContent` 验证）

如果不匹配，抛出错误：`文件在预览后已被修改。请重新加载并生成新的修改建议。`

## 向下兼容性

- ✅ 现有的 `create`/`append`/`replace` 操作完全不受影响
- ✅ 预览生成逻辑统一使用 unified diff 格式
- ✅ AI 模型可以继续使用 `replace`（稳妥但低效）
- ✅ AI 模型可以选择使用 `edit`（精确但需要准确行号）

## 测试覆盖

### 单元测试（28 个测试用例）
- 单行替换、多行替换
- 删除单行、删除多行
- 多处不重叠编辑
- 首行/末行编辑
- 边界情况：空文件、无尾部换行符
- 错误情况：行号越界、重叠、未排序

### 集成测试
- 所有现有的 111 个单元测试通过
- 所有现有的 212 个主进程测试通过
- 所有现有的 36 个 AI 组件测试通过
- TypeScript 类型检查通过

## AI 模型使用指南

AI 模型在调用 `propose_workspace_operation` 工具时可以这样使用：

### 何时使用 `edit`
- 修改文件中的几行（例如：改函数名、改配置项）
- 删除特定的行范围
- 在特定位置插入新内容

### 何时使用 `replace`
- 文件内容需要大范围重构
- 修改涉及大部分行
- 不确定具体行号时

### 注意事项
1. **行号是 1-based**：第一行是 1，不是 0
2. **`edits` 数组必须排序**：按 `startLine` 从小到大
3. **不能重叠**：每个编辑的范围不能与其他编辑重叠
4. **字段互斥**：
   - `edit` 操作用 `edits` 字段，不用 `proposedContent`
   - 其他操作用 `proposedContent`，不用 `edits`

## 未来优化方向

1. **自动降级**：当 `edit` 操作失败时，自动回退到 `replace`
2. **智能合并**：多个小范围编辑自动合并为一个 `replace`
3. **冲突解决**：提供三方合并界面处理文件冲突
4. **性能优化**：大文件懒加载和增量 diff

## 相关文件

- `src/shared/types.ts` - 类型定义
- `electron/line-edits.ts` - 服务端核心逻辑
- `electron/line-edits.test.ts` - 单元测试
- `electron/main/project.ts` - 操作应用逻辑
- `electron/main/ai.ts` - AI 工具 schema
- `src/lib/file-operations.ts` - 客户端验证和预览
- `src/components/ai/MarkdownOperationCard.tsx` - UI 渲染

## 版本信息

- **添加日期**：2026-08-11
- **版本**：4.0.5
- **功能状态**：✅ 已完成并测试通过
