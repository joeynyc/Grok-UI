import { Fragment, type ReactNode } from 'react'

/**
 * Render a bounded subset of Markdown produced by Grok into React elements.
 *
 * The renderer never emits raw HTML. Every construct becomes a React element
 * built from parsed text, so content from a session record cannot inject
 * markup. Supported: headings, paragraphs, fenced and inline code, bold,
 * italic, strikethrough, links (http/https only, opened in a new tab),
 * bullet and numbered lists, block quotes, tables, and horizontal rules.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `markdown ${className}` : 'markdown'}>{renderMarkdown(text)}</div>
}

export function renderMarkdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const output: ReactNode[] = []
  let index = 0
  let key = 0
  const next = () => `md-${key++}`

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1]
      const language = fence[2]
      const body: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      output.push(
        <pre key={next()} data-language={language || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      output.push(<Tag key={next()}>{renderInline(heading[2])}</Tag>)
      index += 1
      continue
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      output.push(<hr key={next()} />)
      index += 1
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      output.push(<blockquote key={next()}>{renderMarkdown(quoted.join('\n'))}</blockquote>)
      continue
    }

    if (isTableStart(lines, index)) {
      const rows: string[] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(lines[index])
        index += 1
      }
      output.push(renderTable(rows, next()))
      continue
    }

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    const numbered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const pattern = ordered ? /^(\s*)\d{1,3}[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/
      const items: string[] = []
      while (index < lines.length) {
        const match = pattern.exec(lines[index])
        if (match) {
          items.push(match[2])
          index += 1
          continue
        }
        // Continuation lines stay attached to the current item.
        if (items.length && lines[index].trim() && /^\s+/.test(lines[index]) && !/^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`
          index += 1
          continue
        }
        break
      }
      const ListTag = ordered ? 'ol' : 'ul'
      output.push(
        <ListTag key={next()}>
          {items.map((item, itemIndex) => {
            const task = /^\[( |x|X)\]\s+(.*)$/.exec(item)
            return (
              <li key={itemIndex} className={task ? (task[1] === ' ' ? 'task' : 'task is-done') : undefined}>
                {task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} aria-hidden="true" /> {renderInline(task[2])}</> : renderInline(item)}
              </li>
            )
          })}
        </ListTag>,
      )
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    if (!paragraph.length) {
      paragraph.push(line)
      index += 1
    }
    output.push(
      <p key={next()}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex > 0 && <br />}
            {renderInline(part)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return output
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  return /^\s*(```|~~~)/.test(line)
    || /^\s{0,3}#{1,6}\s/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)
    || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
    || isTableStart(lines, index)
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]
  const separator = lines[index + 1]
  return Boolean(
    header && separator
    && header.includes('|')
    && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(separator),
  )
}

function splitCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function renderTable(rows: string[], key: string): ReactNode {
  const header = splitCells(rows[0])
  const body = rows.slice(2).map(splitCells)
  return (
    <div className="markdown-table" key={key}>
      <table>
        <thead>
          <tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((_cell, cellIndex) => <td key={cellIndex}>{renderInline(cells[cellIndex] || '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g

export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const [, , code, bold, boldAlt, strike, italic, italicAlt, linkText, linkHref, bareHref] = match
    if (code !== undefined) nodes.push(<code key={key++}>{code.trim() === code ? code : code.slice(1, -1)}</code>)
    else if (bold !== undefined || boldAlt !== undefined) nodes.push(<strong key={key++}>{renderInline(bold ?? boldAlt)}</strong>)
    else if (strike !== undefined) nodes.push(<s key={key++}>{renderInline(strike)}</s>)
    else if (italic !== undefined || italicAlt !== undefined) nodes.push(<em key={key++}>{renderInline(italic ?? italicAlt)}</em>)
    else if (linkText !== undefined) nodes.push(<a key={key++} href={linkHref} target="_blank" rel="noopener noreferrer">{renderInline(linkText)}</a>)
    else if (bareHref !== undefined) nodes.push(<a key={key++} href={bareHref} target="_blank" rel="noopener noreferrer">{bareHref}</a>)
    cursor = start + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
