import { describe, expect, it } from 'vitest'

import {
  clampAiPanelWidth,
  clampProjectNavigatorWidth,
  maximumAiPanelWidth,
  PANEL_LAYOUT
} from '../../src/lib/panel-layout'

describe('panel layout', () => {
  it('uses a dynamic desktop maximum while preserving the editor workspace', () => {
    expect(maximumAiPanelWidth(1_440, 260)).toBe(704)
    expect(maximumAiPanelWidth(1_920, 260)).toBe(PANEL_LAYOUT.aiMaxWidth)
    expect(maximumAiPanelWidth(1_100, 400)).toBe(PANEL_LAYOUT.aiMinWidth)
  })

  it('reclaims navigation space when the left sidebar is hidden', () => {
    expect(maximumAiPanelWidth(1_440, 260, false)).toBe(PANEL_LAYOUT.aiMaxWidth)
  })

  it('uses an overlay limit on compact windows', () => {
    expect(maximumAiPanelWidth(900, 260)).toBe(792)
    expect(maximumAiPanelWidth(1_024, 260)).toBe(PANEL_LAYOUT.aiMaxWidth)
  })

  it('keeps persisted and interactive widths inside visible bounds', () => {
    expect(clampProjectNavigatorWidth(100)).toBe(210)
    expect(clampProjectNavigatorWidth(900)).toBe(400)
    expect(clampAiPanelWidth(900, 712)).toBe(712)
    expect(clampAiPanelWidth(100, 712)).toBe(300)
  })
})
