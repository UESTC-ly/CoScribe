export type TrustedPluginPermission = 'project:read' | 'project:write' | 'ai:request'

export interface TrustedPluginManifest {
  id: string
  name: string
  description: string
  version: string
  kind: 'built-in'
  entry: 'planner'
  permissions: TrustedPluginPermission[]
  features: string[]
}
