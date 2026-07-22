import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROJECT_MEMORY,
  MAX_PROJECT_MEMORY_CHARS,
  normalizeProjectMemory,
  projectMemoryPromptBlock
} from './project-memory'

describe('project memory contract', () => {
  it('normalizes portable Markdown while keeping the transparent default template', () => {
    expect(DEFAULT_PROJECT_MEMORY).toContain('# CoScribe Project Memory')
    expect(normalizeProjectMemory('## 决策\r\n\r\n- 使用 Markdown  \r\n')).toBe('## 决策\n\n- 使用 Markdown\n')
  })

  it('rejects oversized or binary-like memory instead of silently truncating it', () => {
    expect(() => normalizeProjectMemory(`x${'y'.repeat(MAX_PROJECT_MEMORY_CHARS)}`)).toThrow(/不能超过/u)
    expect(() => normalizeProjectMemory('safe\0hidden')).toThrow(/无效字符/u)
  })

  it('labels memory below immutable safety rules instead of blending it into system authority', () => {
    const block = projectMemoryPromptBlock('# 约定\n- 不自动发布')
    expect(block).toContain('<project_memory>')
    expect(block).toContain('优先级低于应用安全规则')
    expect(block).toContain('不自动发布')
  })
})
