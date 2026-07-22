import type { TrustedPluginManifest } from './types'

/**
 * v2 deliberately exposes only audited, built-in plugins. The manifest and
 * permission vocabulary form the extension boundary for a future signed
 * marketplace without evaluating downloaded JavaScript in the renderer.
 */
export const TRUSTED_PLUGIN_REGISTRY: readonly TrustedPluginManifest[] = [
  {
    id: 'planner',
    name: '计划与日程',
    description: '用 Markdown 管理日程、任务和里程碑，并让 AI 快速生成项目计划。',
    version: '1.0.0',
    kind: 'built-in',
    entry: 'planner',
    permissions: ['project:read', 'project:write', 'ai:request'],
    optionalPermissions: ['calendar:write'],
    features: ['日程表', '任务快速录入', 'AI 生成计划', '同步系统日历'],
    activation: 'on-view',
    platforms: ['darwin']
  },
  {
    id: 'daily-notes',
    name: '每日笔记与模板',
    description: '用可编辑模板创建每日、每周笔记，所有内容保持为普通 Markdown。',
    version: '1.0.0',
    kind: 'built-in',
    entry: 'daily-notes',
    permissions: ['project:read', 'project:write'],
    features: ['每日笔记', '每周回顾', '模板变量', '一键打开'],
    activation: 'on-view'
  },
  {
    id: 'flashcards',
    name: '闪卡与间隔复习',
    description: '从项目 Markdown 提取闪卡，在本机安排复习，并让 AI 生成候选卡片。',
    version: '1.0.0',
    kind: 'built-in',
    entry: 'flashcards',
    permissions: ['project:read', 'project:write', 'ai:request'],
    features: ['Markdown 闪卡', '本地复习算法', '到期队列', 'AI 候选卡片'],
    activation: 'on-view'
  },
  {
    id: 'backlinks',
    name: '双向链接',
    description: '查看反向链接、出站链接与未链接提及，快速发现项目中的知识关系。',
    version: '1.0.0',
    kind: 'built-in',
    entry: 'backlinks',
    permissions: ['project:read'],
    features: ['反向链接', '未链接提及', '孤立笔记', '关系概览'],
    activation: 'on-view'
  },
  {
    id: 'diagnostics',
    name: '性能诊断',
    description: '按需查看进程内存、CPU、知识索引与插件状态，不在后台持续采样。',
    version: '1.0.0',
    kind: 'built-in',
    entry: 'diagnostics',
    permissions: ['diagnostics:read'],
    features: ['进程内存', 'CPU 快照', '索引状态', '按需刷新'],
    activation: 'on-view'
  }
] as const

export const PLUGIN_PERMISSION_LABELS: Record<TrustedPluginManifest['permissions'][number], string> = {
  'project:read': '读取当前项目文件',
  'project:write': '创建或修改当前项目文件',
  'ai:request': '发起已配置的 AI 请求',
  'calendar:write': '写入 macOS 日历或提醒事项',
  'diagnostics:read': '读取 CoScribe 进程性能快照'
}

export function trustedPlugin(id: string): TrustedPluginManifest | undefined {
  return TRUSTED_PLUGIN_REGISTRY.find((plugin) => plugin.id === id)
}
