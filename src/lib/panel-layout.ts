export const PANEL_LAYOUT = {
  activityRailWidth: 46,
  resizeHandleWidth: 1,
  projectNavigatorMinWidth: 210,
  projectNavigatorMaxWidth: 400,
  markdownOutlineMinWidth: 168,
  markdownOutlineDefaultWidth: 216,
  markdownOutlineMaxWidth: 520,
  aiMinWidth: 300,
  aiDefaultWidth: 360,
  aiMaxWidth: 800,
  editorMinWidth: 420,
  overlayBreakpoint: 1_100,
  overlayViewportRatio: 0.88
} as const

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function clampProjectNavigatorWidth(width: number): number {
  return clamp(
    finite(width, PANEL_LAYOUT.projectNavigatorMinWidth),
    PANEL_LAYOUT.projectNavigatorMinWidth,
    PANEL_LAYOUT.projectNavigatorMaxWidth
  )
}

export function clampMarkdownOutlineWidth(width: number): number {
  return clamp(
    finite(width, PANEL_LAYOUT.markdownOutlineDefaultWidth),
    PANEL_LAYOUT.markdownOutlineMinWidth,
    PANEL_LAYOUT.markdownOutlineMaxWidth
  )
}

export function maximumAiPanelWidth(viewportWidth: number, navigationWidth: number): number {
  const viewport = Math.max(0, finite(viewportWidth, PANEL_LAYOUT.overlayBreakpoint))
  if (viewport < PANEL_LAYOUT.overlayBreakpoint) {
    return clamp(
      Math.floor(viewport * PANEL_LAYOUT.overlayViewportRatio),
      PANEL_LAYOUT.aiMinWidth,
      PANEL_LAYOUT.aiMaxWidth
    )
  }

  const available = viewport
    - PANEL_LAYOUT.activityRailWidth
    - clampProjectNavigatorWidth(navigationWidth)
    - PANEL_LAYOUT.resizeHandleWidth * 2
    - PANEL_LAYOUT.editorMinWidth

  return clamp(Math.floor(available), PANEL_LAYOUT.aiMinWidth, PANEL_LAYOUT.aiMaxWidth)
}

export function clampAiPanelWidth(width: number, maximum: number = PANEL_LAYOUT.aiMaxWidth): number {
  const resolvedMaximum = clamp(maximum, PANEL_LAYOUT.aiMinWidth, PANEL_LAYOUT.aiMaxWidth)
  return clamp(finite(width, PANEL_LAYOUT.aiDefaultWidth), PANEL_LAYOUT.aiMinWidth, resolvedMaximum)
}
