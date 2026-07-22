import type { PluginPermission } from '../shared/types'

export type TrustedPluginPermission = PluginPermission

export type TrustedPluginEntry =
  | 'planner'
  | 'daily-notes'
  | 'flashcards'
  | 'backlinks'
  | 'diagnostics'
  | 'references'
  | 'review-matrix'
  | 'mcp-connectors'
  | 'git-snapshots'
  | 'web-tracker'

export interface TrustedPluginManifest {
  id: string
  name: string
  description: string
  version: string
  kind: 'built-in'
  entry: TrustedPluginEntry
  permissions: TrustedPluginPermission[]
  optionalPermissions?: TrustedPluginPermission[]
  features: string[]
  activation: 'on-view'
  platforms?: Array<'darwin' | 'win32' | 'linux'>
}
