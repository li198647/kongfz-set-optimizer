// v1.5.1 正确性验证：新版 optimize 必须与 v1.5.0 结果完全一致，且都与暴力穷举（精确解）一致。
//   用法：node test_v151_equiv.js
const fs = require('fs');
const path = require('path');

const NEW_SRC = fs.readFileSync(path.join(__dirname, 'kongfz-set-optimizer.user.js'), 'utf8');
const OLD_SRC = fs.readFileSync(path.join(__dirname, 'kongfz-set-optimizer.user.js.v1.4.14.bak'), 'utf8');   // == v1.5.0

/* ---------- 抽取工具 ---------- */
function grabFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('未找到: ' + header);
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { j++; break; } } }
  return src.slice(i, j);
}
function grabLine(src, prefix) {
  const i = src.indexOf(prefix);
  if (i < 0) throw new Error('未找到行: ' + prefix);
  return src.slice(i, src.indexOf('\n', i));
}
function grabBlock(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i < 0 || j < 0) throw new Error('未找到 OPTIMIZER 标记');
  return src.slice(i, j);
}

const STUB = `
let CONFIG = { debug: false };
let STATE = { aborted: false };
const yieldToBrowser = () => Promise.resolve();
const performance = undefined;
`;
// v1.5.1 新增在块外的依赖
const NEW_DEPS = [
  grabLine(NEW_SRC, 'const _nowMs ='),
  grabLine(NEW_SRC, 'const YIELD_CTL ='),
  grabFn(NEW_SRC, 'function resetYieldCtl()'),
  grabFn(NEW_SRC, 'async function maybeYield()'),
].join('\n');

function build(src, deps, probe) {
  let block = grabBlock(src, '// === OPTIMIZER START ===', '// === OPTIMIZER END ===');
  if (probe) {
    // 插桩：统计三个新分支的实际命中次数，确认测试没有空转
    block = block
      .replace('configMap = await buildShopConfigsSparse(', 'globalThis.__sparse = (globalThis.__sparse||0)+1, configMap = await buildShopConfigsSparse(')
      .replace('    } else {\n      const SZ = 1 << ln;', '    } else {\n      globalThis.__sos = (globalThis.__sos||0)+1;\n      const SZ = 1 << ln;')
      .replace('      if (_cached) {', '      if (_cached) { globalThis.__hit = (globalThis.__hit||0)+1;')
      .replace('const cfgRaw = cfgArr.length;', 'const cfgRaw = cfgArr.length; (globalThis.__cs = globalThis.__cs || []).push(cfgRaw);');
  }
  const body = STUB + '\n' + (deps || '') + '\n' + block +
    '\nreturn { optimize: optimize, resetCache: (typeof resetOptimizerCache === "function" ? resetOptimizerCache : null) };';
  return new Function(body)();
}

const OPT_NEW = build(NEW_SRC, NEW_DEPS);
const OPT_OLD = build(OLD_SRC, '');

/* ---------- 第三方裁判：暴力穷举（枚举所有 listing 子集 + 按店收一次运费） ---------- */
function bruteForce(n, listings) {
  const FULL = (1 << n) - 1;
  // 每家店：非包邮 listing 中的最小运费（与插件 shopShip 口径一致）
  const shopShip = new Map();
  for (const L of listings) {
    if (!L.free && L.shipping > 0) {
      const cur = shopShip.get(L.shopId);
      if (cur === undefined || L.shipping < cur) shopShip.set(L.shopId, L.shipping);
    }
  }
  const L = listings.length;
  let best = Infinity;
  for (let s = 0; s < (1 << L); s++) {
    let cov = 0, priceSum = 0;
    const usedNonFree = new Set();
    for (let i = 0; i < L; i++) {
      if (!(s & (1 << i))) continue;
      const it = listings[i];
      cov |= it.volMask; priceSum += it.price;
      if (!it.free) usedNonFree.add(it.shopId);
    }
    if (cov !== FULL) continue;
    let ship = 0;
    for (const sid of usedNonFree) ship += (shopShip.get(sid) || 0);
    const tot = priceSum + ship;
    if (tot < best) best = tot;
  }
  return best;
}

/* ---------- 随机数据生成 ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genCase(seed) {
  const rnd = mulberry32(seed);
  const n = 1 + Math.floor(rnd() * 9);            // 1..9 册（可控暴力）
  const shopCount = 1 + Math.floor(rnd() * 6);
  const cnt = 1 + Math.floor(rnd() * 14);         // 1..14 条（暴力 2^14 可接受）
  const listings = [];
  for (let k = 0; k < cnt; k++) {
    const shopId = 'S' + Math.floor(rnd() * shopCount);
    let m = 0;
    for (let i = 0; i < n; i++) if (rnd() < 0.4) m |= (1 << i);
    if (m === 0) m = 1 << Math.floor(rnd() * n);
    const free = rnd() < 0.3;
    listings.push({
      volMask: m,
      price: Math.round((1 + rnd() * 40) * 100) / 100,
      shopId, shopName: '店' + shopId,
      free,
      shipping: free ? 0 : Math.round((2 + rnd() * 10) * 100) / 100,
    });
  }
  return { n, listings };
}

/* ---------- 结果规范化（便于比较） ---------- */
function norm(r) {
  if (!r) return { ok: false, err: 'null' };
  if (r.ok) {
    const sum = r.plan.reduce((a, p) => a + p.subtotal, 0);
    let cov = 0, shops = [];
    for (const p of r.plan) {
      for (const L of p.listings) cov |= L.volMask;
      shops.push(p.shop && p.shop.shopId);
    }
    return { ok: true, total: r.total, sum, cov, shops: shops.sort().join('|') };
  }
  return { ok: false, err: r.error, cnt: r.partialCount, total: r.partialTotal };
}

/* ---------- 定向用例：专门触发 v1.5.1 的新分支 ----------
 *   · 稀疏路径：某店只挂 1 条却横跨全部 n 册 → ln = n > 14，走 buildShopConfigsSparse
 *   · SOS 剪枝分支：某店 ln=10 且 items≥10 → configs 数可达 1023 > 300，走 SOS DP
 *   · 部分覆盖：故意留一册无人覆盖，验证 !ok 分支在稀疏/剪枝下仍与旧版一致
 */
function genDirected(seed) {
  const rnd = mulberry32(seed * 7919 + 13);
  const n = 15 + Math.floor(rnd() * 5);              // 15..19 册 → ln=n>14 触发稀疏
  const FULL = (1 << n) - 1;
  const listings = [];
  const mk = (m, shopId, free) => ({
    volMask: m, price: Math.round((1 + rnd() * 40) * 100) / 100,
    shopId, shopName: '店' + shopId, free,
    shipping: free ? 0 : Math.round((2 + rnd() * 10) * 100) / 100,
  });
  // ① 稀疏路径：1 条横跨全 n 册
  listings.push(mk(FULL, 'S0', rnd() < 0.5));
  // ② SOS 剪枝：单店 ln=10。前 10 条是"单位 mask"（保证可达状态填满 2^10=1024）
  //    + 2 条随机组合 → configs≈1023 > 300，且 ln=10 ≤14 走 dense+SOS 剪枝分支
  const volsB = [];
  for (let i = 0; i < n && volsB.length < 10; i++) if (rnd() < 0.6) volsB.push(i);
  while (volsB.length < 10) { const i = Math.floor(rnd() * n); if (volsB.indexOf(i) < 0) volsB.push(i); }
  for (let k = 0; k < 10; k++) listings.push(mk(1 << volsB[k], 'S1', rnd() < 0.3));
  for (let k = 0; k < 2; k++) {
    let m = 0;
    for (const v of volsB) if (rnd() < 0.5) m |= (1 << v);
    if (m === 0) m = 1 << volsB[0];
    listings.push(mk(m, 'S1', rnd() < 0.3));
  }
  // ③ 若干零散小条目（含可能凑不齐的情形）
  const extra = 2;
  for (let k = 0; k < extra; k++) {
    let m = 0;
    for (let i = 0; i < n; i++) if (rnd() < 0.25) m |= (1 << i);
    if (m === 0) m = 1 << Math.floor(rnd() * n);
    listings.push(mk(m, 'S' + (2 + Math.floor(rnd() * 3)), rnd() < 0.4));
  }
  // ④ 一半概率挖掉某一册的全部覆盖 → 构造"凑不齐"
  if (rnd() < 0.5) {
    const kill = Math.floor(rnd() * n);
    for (const L of listings) L.volMask &= ~(1 << kill);
    for (const L of listings) if (L.volMask === 0) L.volMask = 1 << ((kill + 1) % n);
  }
  return { n, listings };
}

(async function main() {
  let pass = 0, fail = 0;
  const fails = [];
  const SEEDS = 400;
  console.log('随机用例 ' + SEEDS + ' 组（n=1..9, listings=1..14），逐组三方比对：v1.5.0 / v1.5.1 / 暴力穷举');

  for (let seed = 1; seed <= SEEDS; seed++) {
    const { n, listings } = genCase(seed);
    const volumes = new Array(n).fill(0).map((_, i) => ({ name: '第' + (i + 1) + '册' }));

    if (OPT_NEW.resetCache) OPT_NEW.resetCache();
    const rn = norm(await OPT_NEW.optimize(volumes, listings, {}));
    const ro = norm(await OPT_OLD.optimize(volumes, listings, {}));
    const rb = bruteForce(n, listings);

    const okA = rn.ok === ro.ok;
    const totalEq = rn.ok ? Math.abs(rn.total - ro.total) < 1e-9 : (rn.cnt === ro.cnt && (rn.total == null && ro.total == null || Math.abs(rn.total - ro.total) < 1e-9));
    // 与暴力对照（只比可行解的最优总价；暴力 Infinity 表示凑不齐，此时只要求新版也不 ok）
    let bruteEq;
    if (rb === Infinity) bruteEq = !rn.ok;
    else bruteEq = rn.ok && Math.abs(rn.total - rb) < 1e-9;
    // 方案自洽：清单 subtotal 之和 == total，且并集覆盖全集
    const selfOk = !rn.ok || (Math.abs(rn.sum - rn.total) < 1e-6 && rn.cov === ((1 << n) - 1));

    if (okA && totalEq && bruteEq && selfOk) { pass++; }
    else {
      fail++;
      if (fails.length < 5) {
        fails.push({ seed, n, listings, rn, ro, rb, okA, totalEq, bruteEq, selfOk });
      }
    }
  }

  console.log('  通过 ' + pass + ' / 失败 ' + fail);

  /* ========== 第二部分：定向用例（稀疏路径 / SOS 剪枝 / 部分覆盖） ========== */
  console.log('\n定向用例 80 组（n=15..19，含"单条横跨全册"触发稀疏 DP、"单店 ln=10"触发 SOS 剪枝、"挖掉一册"触发部分覆盖）');
  let p2 = 0, f2 = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const { n, listings } = genDirected(seed);
    const volumes = new Array(n).fill(0).map((_, i) => ({ name: '第' + (i + 1) + '册' }));
    if (OPT_NEW.resetCache) OPT_NEW.resetCache();
    const rn = norm(await OPT_NEW.optimize(volumes, listings, {}));
    const ro = norm(await OPT_OLD.optimize(volumes, listings, {}));
    const rb = bruteForce(n, listings);

    const okA = rn.ok === ro.ok;
    const totalEq = rn.ok ? Math.abs(rn.total - ro.total) < 1e-9
      : (rn.cnt === ro.cnt && ((rn.total == null && ro.total == null) || Math.abs(rn.total - ro.total) < 1e-9));
    const bruteEq = (rb === Infinity) ? !rn.ok : (rn.ok && Math.abs(rn.total - rb) < 1e-9);
    const selfOk = !rn.ok || (Math.abs(rn.sum - rn.total) < 1e-6 && rn.cov === ((1 << n) - 1));

    if (okA && totalEq && bruteEq && selfOk) p2++;
    else {
      f2++;
      if (fails.length < 5) fails.push({ seed: 'D' + seed, n, listings, rn, ro, rb, okA, totalEq, bruteEq, selfOk });
    }
  }
  console.log('  通过 ' + p2 + ' / 失败 ' + f2);
  pass += p2; fail += f2;

  /* ========== 第三部分：跨方案缓存一致性（v1.5.1 ④） ========== */
  console.log('\n缓存一致性测试：同一实例连续 3 次调用（模拟第1/2/3方案，后者剔除已用店铺）→ 结果须与"每次都清空缓存"完全一致');
  let p3 = 0, f3 = 0;
  const OPT_FRESH = build(NEW_SRC, NEW_DEPS);   // 对照组：每次强制清缓存
  for (let seed = 1; seed <= 60; seed++) {
    const { n, listings } = genDirected(seed * 31 + 5);
    const volumes = new Array(n).fill(0).map((_, i) => ({ name: '第' + (i + 1) + '册' }));

    // A：缓存版（只在开头 resetCache 一次，之后 3 次调用共享缓存）
    OPT_NEW.resetCache();
    let lf = listings.slice();
    const resA = [];
    for (let k = 0; k < 3 && lf.length; k++) {
      const r = await OPT_NEW.optimize(volumes, lf, {});
      resA.push(norm(r));
      const used = new Set((r.ok ? r.plan : (r.partialPlan || [])).map((p) => p.shop && p.shop.shopId));
      lf = lf.filter((L) => !used.has(L.shopId));
    }
    // B：无缓存版（每次调用前清缓存）
    lf = listings.slice();
    const resB = [];
    for (let k = 0; k < 3 && lf.length; k++) {
      OPT_FRESH.resetCache();
      const r = await OPT_FRESH.optimize(volumes, lf, {});
      resB.push(norm(r));
      const used = new Set((r.ok ? r.plan : (r.partialPlan || [])).map((p) => p.shop && p.shop.shopId));
      lf = lf.filter((L) => !used.has(L.shopId));
    }

    let same = resA.length === resB.length;
    if (same) {
      for (let i = 0; i < resA.length; i++) {
        const a = resA[i], b = resB[i];
        if (a.ok !== b.ok) { same = false; break; }
        if (a.ok ? Math.abs(a.total - b.total) > 1e-9 : (a.cnt !== b.cnt || Math.abs((a.total || 0) - (b.total || 0)) > 1e-9)) { same = false; break; }
      }
    }
    if (same) p3++;
    else {
      f3++;
      if (fails.length < 5) fails.push({ seed: 'C' + seed, n, listings, rn: resA, ro: resB, rb: 'cache-diff', okA: same, totalEq: same, bruteEq: true, selfOk: true });
    }
  }
  console.log('  通过 ' + p3 + ' / 失败 ' + f3);
  pass += p3; fail += f3;

  /* ========== 第四部分：分支覆盖探测（确认新代码路径真的被跑到） ========== */
  const OPT_PROBE = build(NEW_SRC, NEW_DEPS, true);
  globalThis.__sparse = 0; globalThis.__sos = 0; globalThis.__hit = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const { n, listings } = genDirected(seed);
    const volumes = new Array(n).fill(0).map((_, i) => ({ name: '第' + (i + 1) + '册' }));
    OPT_PROBE.resetCache();
    let lf = listings.slice();
    for (let k = 0; k < 3 && lf.length; k++) {
      const r = await OPT_PROBE.optimize(volumes, lf, {});
      const used = new Set((r.ok ? r.plan : (r.partialPlan || [])).map((p) => p.shop && p.shop.shopId));
      lf = lf.filter((L) => !used.has(L.shopId));
    }
  }
  const cs = (globalThis.__cs || []).slice().sort((a, b) => b - a);
  console.log('\n分支覆盖探测（80 组定向用例 × 3 方案）：' +
    ' 稀疏DP ' + globalThis.__sparse + ' 次 / SOS剪枝 ' + globalThis.__sos + ' 次 / 缓存命中 ' + globalThis.__hit + ' 次' +
    ' | 单店 configs 最大 ' + (cs[0] || 0) + '（>300 的有 ' + cs.filter((x) => x > 300).length + ' 家店）');
  if (!globalThis.__sparse || !globalThis.__sos || !globalThis.__hit) {
    console.log('⚠ 有分支未被覆盖，测试强度不足');
    fail++; pass--;
  }

  if (fails.length) {
    console.log('\n❌ 前几个失败用例：');
    for (const f of fails) {
      console.log('--- seed=' + f.seed + ' n=' + f.n + ' ---');
      console.log('  v1.5.1: ' + JSON.stringify(f.rn));
      console.log('  v1.5.0: ' + JSON.stringify(f.ro));
      console.log('  暴力  : ' + f.rb);
      console.log('  flags : okSame=' + f.okA + ' totalEq=' + f.totalEq + ' bruteEq=' + f.bruteEq + ' selfOk=' + f.selfOk);
      console.log('  data  : ' + JSON.stringify(f.listings));
    }
    process.exitCode = 1;
  } else {
    console.log('✅ 全部通过：v1.5.1 与 v1.5.0 结果一致，且与暴力精确解一致，方案自洽（覆盖全集、价合计=总价）');
  }
})();
