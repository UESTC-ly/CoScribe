export const AUTO_COMPLETION_DELAY_MS = 420

export function canRequestAutoCompletion(documentText: string, cursor: number, selectionEmpty: boolean): boolean {
  if (!selectionEmpty || cursor < 0 || cursor > documentText.length) return false
  const line = documentText.slice(0, cursor).split(/\r?\n/u).at(-1)?.trim() ?? ''
  return line.length >= 2 && /[\p{L}\p{N}_)\]}"'`]/u.test(line)
}

export function normalizeInlineCompletion(value: string): string | null {
  const completion = value
    .replace(/\r\n?/gu, '\n')
    .replace(/^```[^\n]*\n?/u, '')
    .replace(/\n?```$/u, '')
    .slice(0, 16_000)
  return completion.trim() ? completion : null
}

export function completionSnapshotMatches(
  documentText: string,
  cursor: number,
  expectedDocumentText: string,
  expectedCursor: number
): boolean {
  return documentText === expectedDocumentText && cursor === expectedCursor
}
