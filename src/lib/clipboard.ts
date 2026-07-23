export async function writeClipboardText(text: string): Promise<void> {
  const desktopClipboard = typeof window === 'undefined'
    ? undefined
    : window.coscribe?.clipboard
  if (desktopClipboard) {
    await desktopClipboard.writeText(text)
    return
  }

  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }

  throw new Error('当前环境不支持写入剪贴板。')
}
