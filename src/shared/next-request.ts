export const MAX_NEXT_REQUEST_CHARS = 200

/** A suggestion is draft text, never an executable chat command. */
export function normalizeNextRequest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\s+/gu, ' ')
  if (!text || text.length > MAX_NEXT_REQUEST_CHARS || text.startsWith('/')) return undefined
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return undefined
  return text
}
