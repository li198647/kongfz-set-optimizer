'use strict';
// 一次性基准测试：比较"全局 DP 单店更新"两种写法的真实速度
// 不改动插件，只为估算优化空间。用完可删。
const n = 21, N1 = 1 << n, FULL = N1 - 1;
const ms = () => Number(process.hrtime.bigint()) / 1e6;

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// 构造半稠密 dp（模拟跑了若干店之后的状态，约 50% 可达）
const dp0 = new Float64Array(N1);
for (let i = 1; i < N1; i++) dp0[i] = rnd() < 0.5 ? rnd() * 300 : Infinity;
dp0[0] = 0;

function build(L) {
  const LN1 = 1 << L, WMASK = 1 << (n - L);
  const bits = [];
  for (let i = 0; i < L; i++) bits.push(Math.round(i * (n - 1) / Math.max(1, L - 1)));
  const seen = new Set(), uniq = [];
  for (const b of bits) if (!seen.has(b)) { seen.add(b); uniq.push(b); }
  while (uniq.length < L) { for (let i = 0; i < n; i++) if (!seen.has(i) && uniq.length < L) { seen.add(i); uniq.push(i); } }
  const B = uniq;
  const localAll = B.reduce((a, b) => a | (1 << b), 0);
  const outBits = [];
  for (let i = 0; i < n; i++) if (!(localAll & (1 << i))) outBits.push(i);
  const f = new Float64Array(LN1);
  for (let v = 1; v < LN1; v++) { let pc = 0; for (let b = 0; b < L; b++) if (v & (1 << b)) pc++; f[v] = 3 * pc + 2; }
  const gmOf = new Int32Array(LN1);
  for (let a = 0; a < LN1; a++) { let g = 0; for (let b = 0; b < L; b++) if (a & (1 << b)) g |= 1 << B[b]; gmOf[a] = g; }
  const wOf = new Int32Array(WMASK);
  for (let wc = 0; wc < WMASK; wc++) { let w = 0; for (let i = 0; i < outBits.length; i++) if (wc & (1 << i)) w |= 1 << outBits[i]; wOf[wc] = w; }
  return { L, LN1, WMASK, f, gmOf, wOf };
}

// ===== 方式 A：现状写法（OR 散射写 + 每店全量拷贝 + 对象 cfgArr） =====
function methodA(S, dp) {
  const t = ms();
  const nd = Float64Array.from(dp);                 // 现状：每店拷贝 16MB
  const cfgArr = [];
  for (let k = 1; k < S.LN1; k++) cfgArr.push({ sm: S.gmOf[k], cost: S.f[k], picks: null, base: 1 });
  let upd = 0;
  for (let mask = 0; mask < N1; mask++) {
    const dm = dp[mask]; if (dm === Infinity) continue;
    for (let k = 0; k < cfgArr.length; k++) {
      const e = cfgArr[k];
      const nm = mask | e.sm;
      const cand = dm + e.cost;
      if (cand < nd[nm]) { nd[nm] = cand; upd++; }
    }
  }
  return { t: ms() - t, upd, nd };
}

// ===== 方式 B：分块 min-plus 子集卷积（块内小数组全进缓存，零对象分配） =====
function methodB(S, dp) {
  const t = ms();
  const nd = new Float64Array(N1);                  // 双缓冲只分配一次（实际可原地）
  const g = new Float64Array(S.LN1), h = new Float64Array(S.LN1);
  const f = S.f, gmOf = S.gmOf, LN1 = S.LN1;
  let upd = 0;
  for (let wc = 0; wc < S.WMASK; wc++) {
    const w = S.wOf[wc];
    for (let a = 0; a < LN1; a++) g[a] = dp[w | gmOf[a]];
    for (let a = 0; a < LN1; a++) {
      let best = g[a];                              // v = 空集
      for (let v = a; v; v = (v - 1) & a) { const c = f[v] + g[a ^ v]; if (c < best) best = c; }
      h[a] = best;
    }
    for (let a = 0; a < LN1; a++) { const u = w | gmOf[a]; if (h[a] < dp[u]) upd++; nd[u] = h[a]; }
  }
  return { t: ms() - t, upd, nd };
}

console.log('L=本店涉及册数 | configs=子集数 | A=现状 | B=子集卷积 | 加速比');
console.log('-'.repeat(72));
const results = [];
for (const L of [1, 2, 3, 4, 6, 7, 11]) {
  const S = build(L);
  const a = methodA(S, dp0);
  const b = methodB(S, dp0);
  // 正确性交叉校验
  let diff = 0;
  for (let i = 0; i < N1; i++) if (a.nd[i] !== b.nd[i]) diff++;
  results.push({ L, cfgs: S.LN1 - 1, ta: a.t, tb: b.t, diff });
  console.log(
    `L=${String(L).padStart(2)} | configs=${String(S.LN1 - 1).padStart(4)} | ` +
    `A=${a.t.toFixed(0).padStart(6)}ms | B=${b.t.toFixed(0).padStart(6)}ms | ` +
    `${(a.t / b.t).toFixed(1).padStart(5)}x | 结果差异=${diff}`
  );
}
console.log('\n(结果差异=0 表示两种写法答案完全一致，B 只是更快)');
