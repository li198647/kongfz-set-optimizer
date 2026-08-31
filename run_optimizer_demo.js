// 真实孔网数据 → 状态压缩 DP 求最低凑齐价
// 复用插件里经过 96 项单测验证的 normText / extractVolumes（直接 eval 实时代码）
const fs = require("fs");
const SRC = fs.readFileSync(__dirname + "/kongfz-set-optimizer.user.js", "utf8");
function extractFn(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("未找到 " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
eval(extractFn(SRC, "normText"));
eval(extractFn(SRC, "extractVolumes"));

// ---- 读取三个数据文件 ----
function loadItems(f) {
  let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
  return j?.data?.itemResponse?.list || j?.data?.list || j?.list || [];
}
const items = [
  ...loadItems("list.json"),
  ...loadItems("list_2.json"),
  ...loadItems("list20_fetch.json"),
];

// ---- 按书名归类并解析卷号 ----
function classify(title) {
  if (title.includes("李永乐")) return { base: "李永乐老师给孩子讲物理", parseN: 10, targetN: 10, book: "李永乐老师给孩子讲物理(1-10)" };
  if (title.includes("汉声")) return { base: "汉声数学", parseN: 41, targetN: 21, book: "汉声数学图画书(目标1-21)" };
  return null;
}
const groups = {};
for (const it of items) {
  if (it.isSoldOut) continue;
  const price = Number(it.price);
  if (!(price > 0)) continue;
  const c = classify(it.title || "");
  if (!c) continue;
  const vols = extractVolumes(it.title, c.base, c.parseN);
  if (!vols || vols.size === 0) continue;
  const g = (groups[c.book] ||= { targetN: c.targetN, listings: [] });
  // 只保留 target 范围内的册（>targetN 的卷号对本次目标无意义，直接忽略）
  const mask = 0;
  let m = 0;
  for (const v of vols) if (v >= 1 && v <= c.targetN) m |= (1 << (v - 1));
  if (m === 0) continue; // 这条记录没覆盖目标内的任何册
  g.listings.push({ mask: m, price, shop: it.shopName || "?", title: (it.title || "").slice(0, 60), vols: [...vols].filter(v => v <= c.targetN).sort((a, b) => a - b) });
}

// ---- 状态压缩 DP（带回溯，输出具体买了哪几条）----
function solve(listings, N) {
  const FULL = (1 << N) - 1;
  const INF = Infinity;
  const dp = new Float64Array(FULL + 1).fill(INF);
  const from = new Int32Array(FULL + 1).fill(-1);
  const via = new Int32Array(FULL + 1).fill(-1);
  dp[0] = 0;
  listings.forEach((L, k) => {
    const mask = L.mask, p = L.price;
    for (let s = FULL; s >= 0; s--) {
      if (dp[s] === INF) continue;
      const ns = s | mask;
      if (dp[s] + p < dp[ns]) { dp[ns] = dp[s] + p; from[ns] = s; via[ns] = k; }
    }
  });
  // 回溯选中的记录
  const picks = [];
  let s = FULL;
  while (s > 0 && via[s] !== -1) { picks.push(listings[via[s]]); s = from[s]; }
  return { cost: dp[FULL], picks, FULL };
}

const lines = [];
const log = (...a) => { const s = a.join(" "); lines.push(s); console.log(s); };

for (const [book, g] of Object.entries(groups)) {
  const N = g.targetN;
  log("\n================= " + book + " =================");
  log("可用店铺记录(覆盖目标内册数): " + g.listings.length + " 条");
  // 覆盖率检查
  const covered = new Set();
  for (const L of g.listings) for (let v = 1; v <= N; v++) if (L.mask & (1 << (v - 1))) covered.add(v);
  const missing = [];
  for (let v = 1; v <= N; v++) if (!covered.has(v)) missing.push(v);
  log("目标册数 1-" + N + " 中，数据缺失的册: " + (missing.length ? missing.join(",") : "无（全部可覆盖）"));
  if (missing.length) { log("→ 无法完全凑齐，跳过详细求解。"); continue; }

  const t0 = Date.now();
  const { cost, picks } = solve(g.listings, N);
  const dt = Date.now() - t0;
  if (!isFinite(cost)) { log("→ 未找到可行组合。"); continue; }
  log("⏱ 求解耗时 " + dt + " ms，状态数 " + (1 << N));
  log("💰 凑齐 1-" + N + " 册最低总价 = " + cost.toFixed(2) + " 元（共买 " + picks.length + " 条记录）");
  log("---- 推荐购买清单 ----");
  let sum = 0;
  for (const L of picks) {
    sum += L.price;
    log("  · [" + L.price.toFixed(2) + "元] " + L.shop + " | 含册:" + L.vols.join(",") + " | " + L.title);
  }
  // 校验并集确实覆盖 1..N
  let chk = 0;
  for (const L of picks) chk |= L.mask;
  const ok = chk === ((1 << N) - 1);
  log("✅ 并集校验覆盖 1-" + N + ": " + (ok ? "通过" : "失败") + " | 清单价合计 " + sum.toFixed(2) + " 元（与 DP 一致:" + (Math.abs(sum - cost) < 1e-6) + "）");
}

fs.writeFileSync(__dirname + "/optimizer_result.txt", lines.join("\n"), "utf8");
log("\n（结果已写入 optimizer_result.txt）");
