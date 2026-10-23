// Tables in cards are native Card 2.0 `table` elements, with a markdown fallback
// for deployments whose app/client rejects the element.
import assert from 'node:assert/strict'

const { buildContentCards, tableElement } = await import('../lib/markdown.js')

const longCell = `进行中${'很长的说明'.repeat(12)}`
const markdown = [
  '结论如下：',
  '',
  '| 项目 | 状态 | 耗时 |',
  '| --- | --- | --- |',
  '| 解析 | 完成 | 3s |',
  `| 渲染 | ${longCell} | 12s |`,
].join('\n')

const [native] = buildContentCards({ title: '任务完成', markdown })
const table = native.body.elements.find((el) => el.tag === 'table')
assert.ok(table, 'a native table element is emitted')
assert.equal(native.schema, '2.0')
assert.deepEqual(table.columns.map((c) => c.display_name), ['项目', '状态', '耗时'])
assert.deepEqual(table.columns.map((c) => c.name), ['c1', 'c2', 'c3'])
assert.equal(table.rows.length, 2)
assert.deepEqual(table.rows[0], { c1: '解析', c2: '完成', c3: '3s' })
assert.ok(table.rows[1].c2.endsWith('…'), 'long cells are clipped')
assert.ok(table.rows[1].c2.length <= 60)
assert.equal(table.header_style.background_style, 'grey', 'explicit header styling, not the client gradient')
assert.equal(table.header_style.bold, true)
assert.equal(table.page_size, 10)
assert.equal(native.body.elements.some((el) => el.tag === 'markdown' && el.content.includes('| --- |')), false,
  'no markdown table is emitted in native mode')

// Markdown mode still produces the old rendering (the fallback path).
const [legacy] = buildContentCards({ title: '任务完成', markdown, tableMode: 'markdown' })
assert.ok(legacy.body.elements.some((el) => el.tag === 'markdown' && el.content.includes('| --- |')))
assert.equal(legacy.body.elements.some((el) => el.tag === 'table'), false)

// Empty headers fall back to 列 N, and wide tables are clipped to 6 columns.
const wide = tableElement({ headers: ['', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows: [['1', '2', '3', '4', '5', '6', '7', '8']] })
assert.equal(wide.columns.length, 6)
assert.equal(wide.columns[0].display_name, '列 1')

console.log('table card smoke: all cases passed')
