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

  it('keeps only well-formed in-project annotations', () => {
    const annotations = normalizeAnnotationsForProject([
      { id: 'good', path: path.join(root, 'book.pdf'), page: 2, kind: 'bookmark', createdAt: 1 },
      { id: 'outside', path: '/tmp/other/book.pdf', page: 2, kind: 'bookmark', createdAt: 1 },
      { id: 'bad-page', path: path.join(root, 'book.pdf'), page: 0, kind: 'bookmark', createdAt: 1 }
    ], root)

    expect(annotations.map((item) => item.id)).toEqual(['good'])
  })
})
