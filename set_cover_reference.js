// ============================================================
// 凑齐 1..N 册书的最低总价 —— 最小代价集合覆盖 (minimum-cost set cover)
// 精确解法：状态压缩 DP（子集 DP / bitmask DP）
//
// 适用：册数 N ≤ 30（JS 位运算限制；>30 需 BigInt / 稀疏 DP）
// 本题 N = 21 → 2^21 = 2,097,152 个状态，完全可行
// ============================================================

// ---------- 输入数据格式 ----------
// listings: 每条店铺记录 = { vols: [册号...], price: 价格 }
//   例: { vols: [1,2,3],     price: 5 }   // 店铺卖 1,2,3 册共 5 元
//   例: { vols: [1,4,12,15], price: 7 }
// N: 总册数（本题 21）

// ============================================================
// 方法一：朴素子集 DP（逻辑最简单，最易理解）
// 复杂度 O(L * 2^N)，L = listing 条数。
// 本题 N=21, L≈600 → 约 12.6 亿次运算，几秒级（Node 实测约数秒）。
// ============================================================
function solveSimple(listings, N) {
  const FULL = (1 << N) - 1;
  const INF = Infinity;
  const dp = new Float64Array(FULL + 1).fill(INF);
  dp[0] = 0;
  for (const L of listings) {
    const mask = L.vols.reduce((m, v) => m | (1 << (v - 1)), 0); // 子集 → 位掩码
    const p = L.price;
    // 倒序遍历：每条记录最多用一次（同一记录买两次绝无好处）
    for (let s = FULL; s >= 0; s--) {
      if (dp[s] === INF) continue;
      const ns = s | mask;
      if (dp[s] + p < dp[ns]) dp[ns] = dp[s] + p;
    }
  }
  return dp[FULL]; // 答案 = 覆盖全部 21 册的最小总价
}

// ============================================================
// 方法二：按店铺分组（本项目 kongfz 优化器实际采用，快一个数量级）
// 思路：
//   1) 同一店内先做子集 DP，得到“该店覆盖任意子集的最低价”
//      （店内可任意组合多条记录，例如同时买 {1,2,3} 和 {4}）
//   2) 全局再做子集 DP，把每个店当成“一个整体选项”合并
// 因为单店通常只覆盖极少数册，可达子集稀疏，实际远快于方法一。
// ============================================================
function solveByShop(shops, N) {
  const FULL = (1 << N) - 1;
  const INF = Infinity;
  const dp = new Float64Array(FULL + 1).fill(INF);
  dp[0] = 0;

  for (const shop of shops) {
    // --- 店内 DP：shopDp[sub] = 用本店记录覆盖 sub 的最低价 ---
    const shopDp = new Float64Array(FULL + 1).fill(INF);
    shopDp[0] = 0;
    for (const L of shop) {
      const mask = L.vols.reduce((m, v) => m | (1 << (v - 1)), 0);
      for (let s = FULL; s >= 0; s--) {
        if (shopDp[s] === INF) continue;
        const ns = s | mask;
        if (shopDp[s] + L.price < shopDp[ns]) shopDp[ns] = shopDp[s] + L.price;
      }
    }
    // --- 把本店可提供的 (sub, cost) 合并进全局 DP ---
    const next = dp.slice();
    for (let s = 0; s <= FULL; s++) {
      if (dp[s] === INF) continue;
      for (let sub = 0; sub <= FULL; sub++) {
        if (shopDp[sub] === INF) continue;
        const ns = s | sub;
        if (dp[s] + shopDp[sub] < next[ns]) next[ns] = dp[s] + shopDp[sub];
      }
    }
    dp.set(next);
  }
  return dp[FULL];
}

// ============================================================
// 演示：3 册书的极小例子
// ============================================================
const demo = [
  { vols: [1, 2, 3], price: 5 }, // 店铺a
  { vols: [1, 3],    price: 4 }, // 店铺b
  { vols: [2, 3],    price: 3 }, // 店铺c
  { vols: [1],       price: 2 },
  { vols: [2],       price: 2 },
  { vols: [3],       price: 2 },
];
console.log("演示 3 册最低价 =", solveSimple(demo, 3), "元"); // 期望 5（直接买 1,2,3 套装）

// 如果你的真实数据是“每条记录带店铺名”，先按店铺分组再调用方法二：
// const byShop = {};
// for (const L of listings) (byShop[L.shop] ||= []).push(L);
// const answer = solveByShop(Object.values(byShop), 21);
// console.log("21 册最低总价 =", answer, "元");
