import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders headings, emphasis, inline code, and paragraphs', () => {
    const out = html('## Summary\n\n**Branch:** `main` is *clean* and ~~dirty~~.\nSecond line.')
    expect(out).toContain('<h2>Summary</h2>')
    expect(out).toContain('<strong>Branch:</strong> <code>main</code> is <em>clean</em> and <s>dirty</s>.')
    expect(out).toContain('<br/>Second line.')
  })

  it('renders fenced code without interpreting its contents', () => {
    const out = html('```bash\ngit pull --rebase # **not bold**\n```')
    expect(out).toContain('<pre data-language="bash"><code>git pull --rebase # **not bold**</code></pre>')
  })

  it('renders lists, task items, block quotes, tables, and rules', () => {
    const out = html([
      '- first',
      '- [x] done task',
      '1. one',
      '2. two',
      '',
      '> quoted **text**',
      '',
      '| Commit | Message |',
      '|---|---|',
      '| `0c3e7ef` | control: confirm |',
      '',
      '---',
    ].join('\n'))
    expect(out).toContain('<ul><li>first</li><li class="task is-done">')
    expect(out).toContain('<ol><li>one</li><li>two</li></ol>')
    expect(out).toContain('<blockquote><p>quoted <strong>text</strong></p></blockquote>')
    expect(out).toContain('<th>Commit</th><th>Message</th>')
    expect(out).toContain('<td><code>0c3e7ef</code></td><td>control: confirm</td>')
    expect(out).toContain('<hr/>')
  })

  it('escapes HTML and only links to http(s) targets', () => {
    const out = html('<script>alert(1)</script> [ok](https://example.com) [bad](javascript:alert(1)) <https://x.test>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>')
    expect(out).toContain('[bad](javascript:alert(1))')
    expect(out).toContain('<a href="https://x.test" target="_blank" rel="noopener noreferrer">https://x.test</a>')
  })

  it('leaves underscores inside identifiers alone', () => {
    expect(html('use read_file then list_dir')).toContain('<p>use read_file then list_dir</p>')
  })
})
