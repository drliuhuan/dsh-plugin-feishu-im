/**
 * Markdown → Feishu **Card JSON 2.0**.
 *
 * Why 2.0 and not 1.0: the 2.0 `markdown` element renders the full CommonMark
 * surface — headings 1–6, `>` quotes, fenced code, `<hr>`, and markdown tables.
 * The 1.0 element does not, which is exactly why quotes and `###` headings showed
 * up as literal text in the first build.
 *
 * Docs: https://open.feishu.cn/document/feishu-cards/card-json-v2-structure
 *       https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text
 *
 * Limits that shape this module (from the docs above):
 *   - 200 elements per card;
 *   - at most 4 markdown tables per markdown element, 5 visible rows each
 *     (the client paginates the rest);
 *   - 2.0 requires Feishu client 7.20+; older clients show an upgrade notice.
 */

/** Characters per card, counted on the markdown body. Comfortably under the
 *  message size limit while keeping a card readable and quick to render. */
const CARD_CHAR_BUDGET = 6000

/** Beyond this many parts the tail is dropped with a marker rather than
 *  flooding the chat. */
const MAX_PARTS = 6

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/

function splitCells(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function isTableStart(lines, index) {
  const head = lines[index]
  const next = lines[index + 1]
  if (!head || !next) return false
  if (!head.trim().startsWith('|')) return false
  return TABLE_SEPARATOR.test(next.trim())
}

function readTable(lines, index) {
  const headers = splitCells(lines[index])
  const rows = []
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
    const values = splitCells(lines[cursor])
    if (!values.every((value) => /^:?-{2,}:?$/.test(value))) rows.push(values)
    cursor += 1
  }
  return { headers, rows, next: cursor }
}

/**
 * Split markdown into ordered blocks so a long answer can be paginated without
 * cutting a table or a code fence in half.
 * @returns blocks of `markdown`, `table`, or `hr`.
 */
export function splitMarkdownBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  /** @type {Array<object>} */
  const blocks = []
  let buffer = []
  let fenced = false

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) blocks.push({ type: 'markdown', content })
    buffer = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // A table-looking line inside a code fence is code, not a table.
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      buffer.push(line)
      continue
    }
    if (!fenced && isTableStart(lines, index)) {
      flush()
      const table = readTable(lines, index)
      blocks.push({ type: 'table', headers: table.headers, rows: table.rows })
      index = table.next - 1
      continue
    }
    if (!fenced && /^\s{0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/** Render a parsed table back to the markdown form 2.0 renders natively. */
function tableToMarkdown(table) {
  const headers = table.headers.length > 0 ? table.headers : ['列 1']
  const line = (values) => `| ${headers.map((_, index) => values[index] ?? '').join(' | ')} |`
  return [
    line(headers),
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => line(row)),
  ].join('\n')
}

function weigh(block) {
  if (block.type === 'hr') return 8
  if (block.type === 'markdown') return block.content.length + 40
  return tableToMarkdown(block).length + 40
}

/**
 * Build one or more Card JSON 2.0 cards.
 *
 * @param input.title - header text; a multi-part body suffixes `（i/N）`.
 * @param input.template - header color (`blue`, `green`, `orange`, `red`, …).
 * @param input.markdown - the body, tables included.
 * @param input.subtitle - optional header subtitle (the session label fits here).
 * @param input.note - optional small print footer.
 * @returns ready-to-send `interactive` message payloads.
 */
export function buildContentCards({ title, template = 'blue', markdown, subtitle, note }) {
  const blocks = splitMarkdownBlocks(markdown)
  /** @type {Array<Array<object>>} */
  const parts = []
  let current = []
  let weight = 0

  for (const block of blocks) {
    const blockWeight = weigh(block)
    if (current.length > 0 && weight + blockWeight > CARD_CHAR_BUDGET) {
      parts.push(current)
      current = []
      weight = 0
    }
    current.push(block)
    weight += blockWeight
  }
  if (current.length > 0) parts.push(current)
  if (parts.length === 0) parts.push([{ type: 'markdown', content: '（这一轮没有文本输出）' }])

  const capped = parts.slice(0, MAX_PARTS)
  const dropped = parts.length - capped.length

  return capped.map((part, index) => {
    /** @type {Array<object>} */
    const elements = []
    for (const block of part) {
      if (block.type === 'hr') elements.push({ tag: 'hr' })
      else if (block.type === 'table') elements.push({ tag: 'markdown', content: tableToMarkdown(block) })
      else elements.push({ tag: 'markdown', content: block.content })
    }
    if (dropped > 0 && index === capped.length - 1) {
      elements.push({ tag: 'markdown', content: `<font color='grey'>（内容过长，后 ${dropped} 段已省略）</font>` })
    }
    if (note) elements.push({ tag: 'markdown', content: `<font color='grey'>${note}</font>` })

    const heading = capped.length > 1 ? `${title}（${index + 1}/${capped.length}）` : title
    return {
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      header: {
        title: { tag: 'plain_text', content: heading },
        ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
        template,
      },
      body: { elements },
    }
  })
}
