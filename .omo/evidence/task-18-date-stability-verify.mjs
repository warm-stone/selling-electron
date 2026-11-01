// 日期稳定性机器推演：与 reports.spec.ts 逐字同构的期望逻辑（仅 Date 来源参数化）
// 验证 1 号 / 月中 / 月末 / 跨年 / 3-31 滚月 五种运行日期下期望值
function pad2(n) { return String(n).padStart(2, '0') }
function ymd(now, offsetDays) {
  const d = new Date(now); d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function monthOf(day) { return day.slice(0, 7) }
function monthAggOf(now, month) {
  const TODAY = ymd(now, 0), YESTERDAY = ymd(now, -1)
  const SEED = [{day: TODAY, cents: 1000}, {day: TODAY, cents: 750}, {day: YESTERDAY, cents: 650}]
  const hits = SEED.filter(s => monthOf(s.day) === month)
  return {
    total: (hits.reduce((a, s) => a + s.cents, 0) / 100).toFixed(2),
    orders: hits.length,
    buckets: new Set(hits.map(s => s.day)).size
  }
}
function prevCalendarMonth(now) {
  const d = new Date(now); d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}
const cases = [
  // [运行日期, 本月期望, 上月期望, 说明]
  ['2026-11-01', ['2026-11','17.50',2,1], ['2026-10','6.50',1,1], '每月 1 号（昨日跨月）'],
  ['2026-11-02', ['2026-11','24.00',3,2], ['2026-10','0.00',0,0], '月中（昨日同月；上月空）——原 bug 倒置场景'],
  ['2026-11-30', ['2026-11','24.00',3,2], ['2026-10','0.00',0,0], '月末（昨日同月；上月空）'],
  ['2027-01-01', ['2027-01','17.50',2,1], ['2026-12','6.50',1,1], '跨年 1-01（setMonth 负数进位）'],
  ['2026-03-31', ['2026-03','24.00',3,2], ['2026-03','24.00',3,2], '3-31 滚月（setMonth(-1)→3-03→本月；UI 同算法恒同步）']
]
let fail = 0
for (const [dateStr, [tm, tt, to, tb], [pm, pt, po, pb], label] of cases) {
  const now = new Date(`${dateStr}T12:00:00`)
  const thisMonth = monthOf(ymd(now, 0)), prevMonth = prevCalendarMonth(now)
  const a = monthAggOf(now, thisMonth), b = monthAggOf(now, prevMonth)
  const ok = thisMonth === tm && a.total === tt && a.orders === to && a.buckets === tb
    && prevMonth === pm && b.total === pt && b.orders === po && b.buckets === pb
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  console.log(`  本月 ${thisMonth}: ${a.total}/${a.orders}单/${a.buckets}桶（期望 ${tt}/${to}/${tb}）`)
  console.log(`  上月 ${prevMonth}: ${b.total}/${b.orders}单/${b.buckets}桶（期望 ${pt}/${po}/${pb}）`)
}
process.exit(fail ? 1 : 0)
