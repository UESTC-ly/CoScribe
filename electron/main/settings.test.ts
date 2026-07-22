import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { MAX_CUSTOM_SYSTEM_PROMPT_CHARS, sanitizeSettings } from './settings'

describe('v2 settings boundaries', () => {
  it('keeps a bounded custom system prompt and only trusted plugin IDs', () => {
    const settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      customSystemPrompt: `  ${'x'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_CHARS + 20)}  `,
      enabledPlugins: ['planner', 'backlinks', 'remote-unsigned', 'planner'],
      pluginGrants: {
        planner: ['project:read', 'calendar:write', 'diagnostics:read'],
        backlinks: ['project:read', 'project:write'],
        'remote-unsigned': ['project:read']
      }
    })

    expect(settings.customSystemPrompt).toHaveLength(MAX_CUSTOM_SYSTEM_PROMPT_CHARS)
    expect(settings.enabledPlugins).toEqual(['planner', 'backlinks'])
    expect(settings.pluginGrants).toEqual({
      planner: ['project:read', 'calendar:write'],
      backlinks: ['project:read']
    })
  })

  it('restores memory and plugin defaults for older settings files', () => {
    const settings = sanitizeSettings({ baseUrl: DEFAULT_SETTINGS.baseUrl, imageBaseUrl: DEFAULT_SETTINGS.imageBaseUrl })
    expect(settings.projectMemoryEnabled).toBe(true)
    expect(settings.enabledPlugins).toEqual(['planner'])
    expect(settings.pluginGrants).toEqual(DEFAULT_SETTINGS.pluginGrants)
  })
})
