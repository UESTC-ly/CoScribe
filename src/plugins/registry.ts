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
    features: ['日程表', '任务快速录入', 'AI 生成计划', 'Markdown 可移植']
  }
] as const

export function trustedPlugin(id: string): TrustedPluginManifest | undefined {
  return TRUSTED_PLUGIN_REGISTRY.find((plugin) => plugin.id === id)
}
