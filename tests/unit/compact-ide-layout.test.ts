import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('compact IDE layout contract', () => {
  it('keeps the AI panel beside the IDE instead of covering editor controls', async () => {
    const [appSource, shellStyles] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/App.tsx'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/styles/shell.css'), 'utf8')
    ])

    expect(appSource).toContain("state.workspace.navSection === 'ide' ? 'is-ide-workspace' : ''")
    expect(shellStyles).toMatch(
      /\.app-shell\.is-ide-workspace\s+\.app-body\s*>\s*\.ai-workspace\s*\{[\s\S]*?position:\s*static\s*!important;[\s\S]*?width:\s*min\(var\(--ai-width,[\s\S]*?\)\s*!important;/u
    )
  })
})
