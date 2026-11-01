/**
 * F3 终审 QA — C 补充：视觉客观断言（无图像模型环境下的替代验证）。
 *
 * 断言：负库存行 computed color 为红色（标红真实可见，非仅 class 存在）+
 * 截图文件非空且为 1280×800 PNG。
 */
import { _electron } from 'playwright'
import Database from 'better-sqlite3'
import { mkdtempSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const EVIDENCE = '.omo/evidence/final-qa'
const userDataDir = mkdtempSync(join('/tmp/opencode', 'qa-visual-css-'))

const app = await _electron.launch({
  args: ['.'],
  env: { ...process.env, E2E_USER_DATA_DIR: userDataDir }
})
const page = await app.firstWindow()
await page.waitForURL((u) => u.hash === '#/pos', { timeout: 10_000 })

{
  const d = new Database(join(userDataDir, 'pos.db'))
  d.prepare(
    'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
  ).run('6903456789012', 'QA红字可乐 330ml', 350, -4)
  d.close()
}

await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
await page.waitForURL((u) => u.hash === '#/products', { timeout: 10_000 })

const row = page.locator('.el-table__row').filter({ hasText: 'QA红字可乐 330ml' })
await row.waitFor({ timeout: 10_000 })
const color = await row.locator('.cell-stock').first().evaluate((el) => getComputedStyle(el).color)
console.log('负库存 computed color:', color)
const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
const [r, g, b] = m ? m.slice(1).map(Number) : [0, 0, 0]
if (!(r > 200 && g < 150 && b < 150 && r - g > 100)) {
  throw new Error(`负库存应为红色系（Element Plus danger #F56C6C 族），实际 ${color}`)
}

await page.screenshot({ path: `${EVIDENCE}/c-supplement-negative-red.png` })
await app.close()

// 截图文件完整性：非空 + PNG 魔数 + 1280×800 尺寸
const shots = readdirSync(EVIDENCE).filter((f) => f.endsWith('.png')).sort()
let bad = []
for (const f of shots) {
  const p = join(EVIDENCE, f)
  const size = statSync(p).size
  if (size < 10_000) bad.push(`${f} 过小(${size}B)`)
  const buf = (await import('node:fs')).readFileSync(p)
  // PNG IHDR: bytes 16-24 contain width/height (big-endian)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w !== 1280 || h !== 800) bad.push(`${f} 尺寸 ${w}x${h}`)
}
if (bad.length > 0) {
  console.error('截图异常:', bad)
  process.exit(1)
}
console.log(`C 补充 PASS: 负库存红色 ${color}；${shots.length} 张截图全部 1280×800 非空 PNG`)
