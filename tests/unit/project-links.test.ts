import { describe, expect, it } from 'vitest'

import { resolveProjectAssetUrl, resolveProjectFilePath } from '../../src/lib'

describe('project Markdown links', () => {
  const root = '/study/project'
  const document = '/study/project/notes/chapter.md'

  it('resolves files and images relative to the current Markdown file', () => {
    expect(resolveProjectFilePath(root, document, '../assets/图 1.png'))
      .toBe('/study/project/assets/图 1.png')
    expect(resolveProjectAssetUrl(root, document, '../assets/图 1.png'))
      .toBe('coscribe-file://project/assets/%E5%9B%BE%201.png')
  })

  it('treats a leading slash as the project root', () => {
    expect(resolveProjectFilePath(root, document, '/README.md#intro'))
      .toBe('/study/project/README.md')
  })

  it('refuses traversal and leaves remote resources unchanged', () => {
    expect(resolveProjectFilePath(root, document, '../../../secret.txt')).toBeNull()
    expect(resolveProjectAssetUrl(root, document, '../../../secret.png')).toBe('')
    expect(resolveProjectAssetUrl(root, document, 'https://example.com/image.png'))
      .toBe('https://example.com/image.png')
  })
})
