// 用真实孔网汉声数学数据，eval 油猴里的 optimize() 看返回结构
const fs = require("fs");
const SRC = fs.readFileSync(__dirname + "/kongfz-set-optimizer.user.js", "utf8");

// ============ 1) 抽出 optimize 函数本体 ============
function extractFn(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) {
    const sa = src.indexOf("async function " + name);
    if (sa < 0) throw new Error("未找到 " + name);
    return extractFn(src, name).replace(/^function /, "async function ");
  }
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
// 直接抽取 optimize（async function 版本）；它的依赖（CONFIG, yieldToBrowser, _t 等）也得 stub
function extractBlock(src, markerText, openIdx) {
  let i = src.indexOf(markerText, openIdx);
  if (i < 0) throw new Error("未找到 marker: " + markerText);
  let j = src.indexOf("{", i), depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

// 取 optimize 函数本体
const optMatch = SRC.match(/async function optimize\(volumes, listings, opts\) \{[\s\S]*?\n  \}\n/);
if (!optMatch) throw new Error("未抽出 optimize");
const optCode = optMatch[0];

// 抽 yieldToBrowser（可能版本不同；找不到就 stub）
const yldMatch = SRC.match(/function yieldToBrowser\(\) \{[\s\S]*?\n  \}/);
const yldCode = yldMatch ? yldMatch[0] : "function yieldToBrowser() { return new Promise(r => setTimeout(r, 0)); }";

// 抽 CONFIG
const cfgMatch = SRC.match(/const CONFIG = \{[\s\S]*?\};/);
const cfgCode = cfgMatch ? cfgMatch[0] : "const CONFIG = { debug: true };";

// 抽 _t helper —— optimize 内部自己又定义了一次 const _t，会在 new Function 作用域内冲突，**不要抽**
const tCode = '';

// 把所有依赖放在一起 eval（直接执行，不返回值）
const sandbox = [
  cfgCode,
  yldCode,
  tCode,
  optCode,
  // 装个"回溯补丁"：在 optimize 末尾、return 之前把 dp[FULL]/choice 链打出来
  "globalThis.__bench_patch = (orig) => async function(volumes, listings, opts) { const r = await orig(volumes, listings, opts); console.log('[bench] 返回 ok=' + r.ok + ' total=' + (r.total === Infinity ? 'Inf' : r.total) + ' plan.length=' + (r.plan ? r.plan.length : 'no-plan')); return r; };",
  "globalThis.__opt = optimize; globalThis.__yield = yieldToBrowser; globalThis.__cfg = CONFIG;",
].join("\n");
try {
  new Function(sandbox)();
} catch (e) {
  console.error("sandbox 总长=", sandbox.length);
  console.error("尾 50 字符 =", JSON.stringify(sandbox.slice(-50)));
  throw e;
}
const ctx = {
  optimize: globalThis.__opt,
  yieldToBrowser: globalThis.__yield,
  CONFIG: globalThis.__cfg,
};

// ============ 2) 加载真实 listings（复用 run_optimizer_demo.js 的思路） ============
function loadItems(f) {
  let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return []; }
  return j?.data?.itemResponse?.list || j?.data?.list || j?.list || [];
}
function extractFn2(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("not found " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
eval(extractFn2(SRC, "normText"));
eval(extractFn2(SRC, "extractVolumes"));

const items = [
  ...loadItems("list_2.json"),
];

// 归类为汉声 21 册
const targetN = 21;
const parseN = 41;
const base = "汉声数学";
const volumes = [];
for (let i = 1; i <= targetN; i++) volumes.push({ name: "第" + i + "册", keyword: base + i });

// 构造 listings（带 volMask / free / shipping / shopId 等字段）
const listings = [];
let dumpIdx = 0;
const seen = new Set();
for (const it of items) {
  if (it.isSoldOut) continue;
  const price = Number(it.price);
  if (!(price > 0)) continue;
  const title = it.title || "";
  if (!title.includes("汉声")) continue;
  const vols = extractVolumes(title, base, parseN);
  if (!vols || vols.size === 0) continue;
  let m = 0;
  for (const v of vols) if (v >= 1 && v <= targetN) m |= (1 << (v - 1));
  if (m === 0) continue;
  const free = (it.freeShip === true) || (it.postage && it.postage.sellerPayFreight === true) || false;
  const shipping = (free ? 0 : Number((it.postage && (it.postage.price ?? it.postage.amount ?? it.postage.freight)) || 0));
  const shopId = (it.shopInfo && it.shopInfo.shopId) || (it.shopId) || ("shop-" + (it.shopName || "anon"));
  const key = shopId + "|" + title;
  if (seen.has(key)) continue;
  seen.add(key);
  listings.push({
    itemId: "i" + (dumpIdx++),
    title, shopId, shopName: it.shopName || "?",
    shopLink: (it.shopInfo && it.shopInfo.shopLink) || "",
    price, shipping, free, link: "",
    volMask: m,
  });
}

console.log("listings:", listings.length, "条");
// 找单条覆盖满 21 卷的 listings（这种最容易出问题）
const fullCover = listings.filter(L => L.volMask === ((1 << targetN) - 1));
console.log("单条覆盖全 21 卷的 listing:", fullCover.length);
for (const L of fullCover) console.log("  [" + L.price + "+" + (L.free ? 0 : L.shipping) + "元] " + L.shopName + " | " + L.title.slice(0, 80));

// ============ 3) 跑 optimize ============
(async () => {
  const t0 = Date.now();
  const res = await ctx.optimize(volumes, listings, {});
  const dt = Date.now() - t0;
  console.log("\n=== optimize 返回 ===");
  console.log(JSON.stringify({
    ok: res.ok,
    error: res.error,
    total: res.total,
    plan_length: res.plan ? res.plan.length : "no plan",
  }, null, 2));

  if (res.plan && res.plan.length) {
    console.log("---- 方案明细 ----");
    for (const p of res.plan) {
      console.log("店:" + p.shop.shopName + " shipping=" + p.shipping + " subtotal=" + p.subtotal);
      for (const L of p.listings) {
        const vols = [];
        let m = L.volMask;
        while (m) { const v = (Math.log2(m & -m) | 0); vols.push(v + 1); m &= m - 1; }
        console.log("  [" + L.price + "+" + (L.free ? 0 : L.shipping) + "元] covers卷" + vols.join(",") + ": " + L.title.slice(0, 60));
      }
    }
    const chk = res.plan.reduce((m, p) => m | p.listings.reduce((mm, L) => mm | L.volMask, 0), 0);
    const full = (1 << targetN) - 1;
    console.log("并集校验覆盖 1-" + targetN + ": " + (chk === full ? "✅通过" : "❌不全 chk=" + chk.toString(2)));
  }
  console.log("\n⏱ 耗时 " + dt + " ms");
})();
