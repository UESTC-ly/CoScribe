import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizeAnnotationsForProject, normalizeSessionsForProject } from './project'

describe('project metadata recovery', () => {
  const root = path.resolve('/tmp/coscribe-metadata')

  it('drops malformed messages and project-external context paths', () => {
    const sessions = normalizeSessionsForProject([{
      id: 'session-1',
      title: 'Recovered',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        null,
        { id: 'broken', role: 'assistant', content: 42 },
        {
          id: 'valid',
          role: 'user',
          content: 'hello',
          createdAt: 3,
          context: {
            projectName: 'Old',
            projectPath: '/outside',
            pane: 'primary',
            documentPath: '/outside/secret.md',
            scope: 'visible',
            referencedFiles: ['/outside/secret.md'],
            capturedAt: 4
          }
        }
      ]
    }], root)

    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages).toHaveLength(1)
    expect(sessions[0].messages[0].context).toMatchObject({ projectPath: root, referencedFiles: [] })
    expect(sessions[0].messages[0].context?.documentPath).toBeUndefined()
  })

  it('makes a persisted pending operation non-writable after restart', () => {
    const [session] = normalizeSessionsForProject([{
      id: 'session-1',
      title: 'Recovered',
      createdAt: 1,
      updatedAt: 2,
      messages: [{
        id: 'answer',
        role: 'assistant',
        content: 'preview',
        createdAt: 3,
        operation: {
          id: 'operation-1',
          kind: 'create',
          targetPath: path.join(root, 'note.md'),
          proposedContent: '# note',
          summary: 'create note',
          status: 'pending'
        }
      }]
    }], root)

    expect(session.messages[0].operation).toMatchObject({ status: 'failed' })
    expect(session.messages[0].operation?.error).toContain('重新生成')
  })

  it('restores verified HTTP web context and source while dropping privileged URLs', () => {
    const [session] = normalizeSessionsForProject([{
      id: 'session-web',
      title: 'Web research',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'web-good',
          role: 'user',
          content: 'summarize',
          createdAt: 3,
          context: {
            projectName: 'Research',
            projectPath: root,
            pane: 'primary',
            documentName: 'Secure page',
            webUrl: 'https://example.com/guide',
            documentText: 'WEB_TEXT',
            scope: 'document',
            referencedFiles: [],
            capturedAt: 3
          },
          sources: [{ path: 'https://example.com/guide', label: 'Secure page', kind: 'web' }]
        },
        {
          id: 'web-bad',
          role: 'user',
          content: 'bad',
          createdAt: 4,
          context: {
            projectName: 'Research',
            projectPath: root,
            pane: 'primary',
            webUrl: 'file:///tmp/secret',
            scope: 'document',
            referencedFiles: [],
            capturedAt: 4
          },
          sources: [{ path: 'javascript:alert(1)', label: 'Bad', kind: 'web' }]
        }
      ]
    }], root)

    expect(session.messages[0].context?.webUrl).toBe('https://example.com/guide')
    expect(session.messages[0].sources).toEqual([{ path: 'https://example.com/guide', label: 'Secure page', kind: 'web' }])
    expect(session.messages[1].context?.webUrl).toBeUndefined()
    expect(session.messages[1].sources).toBeUndefined()
  })

  it('restores valid user and generated-image attachments while dropping corrupt metadata', () => {
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/AA=='
    const [recovered] = normalizeSessionsForProject([{
      id: 'session-images',
      title: 'Images',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'user-image',
          role: 'user',
          content: '',
          createdAt: 3,
          attachments: [
            {
              id: 'upload-1',
              name: 'diagram.png',
              mimeType: 'image/png',
              dataUrl: pngDataUrl,
              size: 999
            },
            {
              id: 'broken',
              name: 'broken.png',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,not-base64!',
              size: 10
            }
          ]
        },
        {
          id: 'generated-image',
          role: 'assistant',
          content: '已生成图片。',
          createdAt: 4,
          attachments: [{
            id: 'generated-1',
            name: 'gpt-image-2.jpg',
            mimeType: 'image/jpeg',
            dataUrl: jpegDataUrl,
            size: 999,
            projectRelativePath: 'assets/ai-images/gpt-image-2.jpg',
            absolutePath: path.join(root, 'assets/ai-images/gpt-image-2.jpg')
          }]
        },
        {
          id: 'system-image',
          role: 'system',
          content: 'system',
          createdAt: 5,
          attachments: [{
            id: 'not-allowed',
            name: 'system.png',
            mimeType: 'image/png',
            dataUrl: pngDataUrl,
            size: 8
          }]
        }
      ]
    }], root)

    expect(recovered.messages[0].attachments).toEqual([{
      id: 'upload-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      dataUrl: pngDataUrl,
      size: 8
    }])
    expect(recovered.messages[1].attachments).toEqual([{
      id: 'generated-1',
      name: 'gpt-image-2.jpg',
      mimeType: 'image/jpeg',
      dataUrl: jpegDataUrl,
      size: 4,
      projectRelativePath: 'assets/ai-images/gpt-image-2.jpg',
      absolutePath: path.join(root, 'assets/ai-images/gpt-image-2.jpg')
    }])
    expect(recovered.messages[2].attachments).toBeUndefined()
  })

  it('keeps only well-formed in-project annotations', () => {
    const annotations = normalizeAnnotationsForProject([
      { id: 'good', path: path.join(root, 'book.pdf'), page: 2, kind: 'bookmark', createdAt: 1 },
      { id: 'outside', path: '/tmp/other/book.pdf', page: 2, kind: 'bookmark', createdAt: 1 },
      { id: 'bad-page', path: path.join(root, 'book.pdf'), page: 0, kind: 'bookmark', createdAt: 1 }
    ], root)

    expect(annotations.map((item) => item.id)).toEqual(['good'])
  })
})
