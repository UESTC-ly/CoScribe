import { describe, expect, it } from 'vitest'

import {
  appendPlannerTask,
  createPlannerMarkdown,
  parsePlannerTasks,
  type PlannerTask
} from '../../src/plugins/planner/planner-utils'

const task: PlannerTask = {
  date: '2026-07-23',
  time: '09:30',
  title: '整理需求 | 确认范围',
  status: '进行中',
  priority: '高',
  notes: '与团队同步\n记录结论'
}

describe('planner Markdown format', () => {
  it('round-trips a task while preserving Markdown table separators', () => {
    const markdown = appendPlannerTask(createPlannerMarkdown(), task)
    expect(markdown).toContain('整理需求 \\| 确认范围')
    expect(parsePlannerTasks(markdown)).toEqual([task])
  })

  it('adds a portable planner section to an existing ordinary note', () => {
    const markdown = appendPlannerTask('# Existing\n\nKeep this.', task)
    expect(markdown).toContain('# Existing')
    expect(markdown).toContain('<!-- coscribe:planner:start -->')
    expect(parsePlannerTasks(markdown)).toEqual([task])
  })

  it('ignores malformed rows instead of inventing tasks', () => {
    const markdown = createPlannerMarkdown().replace(
      '<!-- coscribe:planner:end -->',
      '| tomorrow | — | not portable | 待办 | 中 | — |\n<!-- coscribe:planner:end -->'
    )
    expect(parsePlannerTasks(markdown)).toEqual([])
  })
})
