// v1.5.1 性能实测：与 v1.5.0 对比（真实孔网数据 + 放大合成数据），并可模拟浏览器"让位被节流"
//   用法：node bench_v151.js
const fs = require('fs');
const path = require('path');

const NEW_SRC = fs.readFileSync(path.join(__dirname, 'kongfz-set-optimizer.user.js'), 'utf8');
const OLD_SRC = fs.readFileSync(path.join(__dirname, 'kongfz-set-optimizer.user.js.v1.4.14.bak'), 'utf8');

/* ---------- 抽出两个版本的 optimize ---------- */
function grabFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('未找到: ' + header);
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { j++; break; } } }
  return src.slice(i, j);
}
function grabLine(src, prefix) { const i = src.indexOf(prefix); return src.slice(i, src.indexOf('\n', i)); }
function grabBlock(src, a, b) { return src.slice(src.indexOf(a), src.indexOf(b)); }

// yieldCostMs：模拟一次让位的真实等待成本（Node 正常 ≈0；浏览器被节流时可达 500ms）
function build(src, deps, yieldCostMs) {
  const block = grabBlock(src, '// === OPTIMIZER START ===', '// === OPTIMIZER END ===');
  const stub = `
let CONFIG = { debug: false };
let STATE = { aborted: false };
const performance = undefined;
const yieldToBrowser = ${yieldCostMs > 0
    ? '() => new Promise(r => setTimeout(r, ' + yieldCostMs + '))'
    : '() => Promise.resolve()'};
`;
  const body = stub + '\n' + (deps || '') + '\n' + block +
    '\nreturn { optimize: optimize, resetCache: (typeof resetOptimizerCache === "function" ? resetOptimizerCache : null) };';
  return new Function(body)();
}
const NEW_DEPS = [
  grabLine(NEW_SRC, 'const _nowMs ='),
  grabLine(NEW_SRC, 'const YIELD_CTL ='),
  grabFn(NEW_SRC, 'function resetYieldCtl()'),
  grabFn(NEW_SRC, 'async function maybeYield()'),
].join('\n');

/* ---------- 解析真实数据 ---------- */
eval(grabFn(NEW_SRC, 'function normText'));
eval(grabFn(NEW_SRC, 'function extractVolumes'));
function loadItems(f) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch { return []; }
  return j?.data?.itemResponse?.list || j?.data?.list || j?.list || [];
}

const N = 21;   // 汉声数学目标 1-21 册
function realListings() {
  const items = [...loadItems('list.json'), ...loadItems('list_2.json'), ...loadItems('list20_fetch.json')];
  const out = [];
  for (const it of items) {
    if (it.isSoldOut) continue;
    const price = Number(it.price);
    if (!(price > 0)) continue;
    if (!((it.title || '').includes('汉声'))) continue;
    const vols = extractVolumes(it.title, '汉声数学', 41);
    if (!vols || vols.size === 0) continue;
    let m = 0;
    for (const v of vols) if (v >= 1 && v <= N) m |= (1 << (v - 1));
    if (!m) continue;
    out.push({
      volMask: m, price, shopId: String(it.shopId), shopName: it.shopName || '?',
      free: false, shipping: 12, itemId: it.itemId, title: it.title,
    });
  }
  return out;
}

// 放大：在真实条目基础上变异出更多店铺（保持价格/卷掩码分布，便于压到真实规模）
function amplify(base, targetCount, seed) {
  let a = seed || 12345;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = base.slice();
  while (out.length < targetCount) {
    const src = base[Math.floor(rnd() * base.length)];
    let m = src.volMask;
    // 随机扰动：翻转 1~2 个位，制造新的组合
    const flips = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < flips; k++) m ^= (1 << Math.floor(rnd() * N));
    if (m === 0) m = src.volMask;
    out.push({
      volMask: m,
      price: Math.max(1, Math.round((src.price * (0.6 + rnd() * 0.9)) * 100) / 100),
      shopId: 'X' + Math.floor(rnd() * 900),
      shopName: '合成店' + Math.floor(rnd() * 900),
      free: rnd() < 0.25,
      shipping: 8 + Math.round(rnd() * 8),
      itemId: 'syn' + out.length, title: src.title,
    });
  }
  return out;
}

const volumes = new Array(N).fill(0).map((_, i) => ({ name: '第' + (i + 1) + '册', keyword: '汉声数学' + (i + 1) }));

async function runOnce(opt, listings, withCacheReset) {
  if (opt.resetCache && withCacheReset !== false) opt.resetCache();
  const t0 = Date.now();
  const r = await opt.optimize(volumes, listings, {});
  return { ms: Date.now() - t0, total: r.ok ? r.total : (r.partialTotal != null ? r.partialTotal : null), ok: r.ok, plan: r.ok ? r.plan : (r.partialPlan || []) };
}

(async function main() {
  const real = realListings();
  const shops = new Set(real.map((L) => L.shopId)).size;
  console.log('真实数据：汉声数学 ' + real.length + ' 条记录 / ' + shops + ' 家店 / 目标 ' + N + ' 册（2^' + N + '=' + (1 << N) + ' 状态）');

  const datasets = [
    { name: '真实 ' + real.length + ' 条', listings: real },
    { name: '放大 600 条', listings: amplify(real, 600, 20260902) },
  ];

  // ===== 1) 纯计算耗时（让位成本 ≈ 0，模拟浏览器前台正常情况）=====
  console.log('\n【1】纯计算耗时（yield 成本≈0，只看算法本身）');
  const OLD0 = build(OLD_SRC, '', 0);
  const NEW0 = build(NEW_SRC, NEW_DEPS, 0);
  for (const ds of datasets) {
    await NEW0.resetCache();
    const o = await runOnce(OLD0, ds.listings, false);
    const n = await runOnce(NEW0, ds.listings, true);
    const speed = o.ms > 0 ? (o.ms / Math.max(1, n.ms)).toFixed(2) : '-';
    console.log('  ' + ds.name.padEnd(16) +
      ' v1.5.0: ' + String(o.ms).padStart(7) + 'ms (总价 ' + (o.total == null ? '凑不齐' : o.total.toFixed(2)) + ')' +
      ' | v1.5.1: ' + String(n.ms).padStart(7) + 'ms (总价 ' + (n.total == null ? '凑不齐' : n.total.toFixed(2)) + ')' +
      ' | 提速 ' + speed + 'x' + (Math.abs((o.total || 0) - (n.total || 0)) < 1e-9 ? ' ✅结果一致' : ' ❌结果不一致!'));
  }

  // ===== 2) 三方案总耗时（跨方案缓存的收益）=====
  console.log('\n【2】连续算 3 个方案的总耗时（第2/3方案剔除已用店铺；v1.5.1 有跨方案缓存）');
  for (const ds of datasets) {
    for (const [tag, opt] of [['v1.5.0', OLD0], ['v1.5.1', NEW0]]) {
      if (opt.resetCache) opt.resetCache();
      let lf = ds.listings.slice();
      let total = 0, t0 = Date.now(), last = null;
      for (let k = 0; k < 3 && lf.length; k++) {
        const r = await opt.optimize(volumes, lf, {});
        last = r;
        const used = new Set((r.ok ? r.plan : (r.partialPlan || [])).map((p) => p.shop && p.shop.shopId));
        lf = lf.filter((L) => !used.has(L.shopId));
        if (opt.resetCache) { /* v1.5.1 不清缓存，让第2/3方案命中 */ }
      }
      total = Date.now() - t0;
      console.log('  ' + ds.name.padEnd(16) + ' ' + tag + ': ' + String(total).padStart(7) + 'ms');
    }
  }

  // ===== 3) 模拟"让位被节流"（每次 yield 真等 50ms，模拟浏览器失焦/开着 F12）=====
  console.log('\n【3】模拟让位被节流（每让位一次真等 50ms；真实环境实测可达 499ms/次）');
  const OLD50 = build(OLD_SRC, '', 50);
  const NEW50 = build(NEW_SRC, NEW_DEPS, 50);
  const ds = datasets[0];
  await NEW50.resetCache();
  const o50 = await runOnce(OLD50, ds.listings, false);
  const n50 = await runOnce(NEW50, ds.listings, true);
  console.log('  ' + ds.name.padEnd(16) +
    ' v1.5.0: ' + String(o50.ms).padStart(7) + 'ms | v1.5.1: ' + String(n50.ms).padStart(7) +
    'ms | 提速 ' + (o50.ms / Math.max(1, n50.ms)).toFixed(1) + 'x' +
    '（v1.5.0 每 50ms 就让一次位 → 让位次数≈耗时/50；v1.5.1 自适应把预算放大到成本×20）');
})();
