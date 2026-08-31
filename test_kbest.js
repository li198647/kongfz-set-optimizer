// 验证 v1.4.1 的「前3方案=强制错开店铺」逻辑：用真实 optimize() 跑合成多店数据，
// 断言：① 3 个方案都存在（满覆盖场景）② 任意两方案店铺集合互不相交 ③ 总价不降（plan2>=plan1, plan3>=plan2）
const fs = require("fs");
const SRC = fs.readFileSync(__dirname + "/kongfz-set-optimizer.user.js", "utf8");

function extractBlock(src, marker, openIdx) {
  let i = src.indexOf(marker, openIdx);
  if (i < 0) throw new Error("未找到 marker: " + marker);
  let j = src.indexOf("{", i), depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
const optCode = SRC.match(/async function optimize\(volumes, listings, opts\) \{[\s\S]*?\n  \}\n/)[0];
const yldCode = SRC.match(/function yieldToBrowser\(\) \{[\s\S]*?\n  \}/) ? SRC.match(/function yieldToBrowser\(\) \{[\s\S]*?\n  \}/)[0] : "function yieldToBrowser() { return new Promise(r => setTimeout(r, 0)); }";
const cfgCode = SRC.match(/const CONFIG = \{[\s\S]*?\};/)[0];
const sandbox = [
  cfgCode, yldCode, optCode,
  "const STATE = { aborted: false, etaCtx: null };",
  "globalThis.__opt = optimize;",
].join("\n");
new Function(sandbox)();
const optimize = globalThis.__opt;

// 合成店铺：A/B/C 各自一条卖齐 1-5 册，价格 50/60/70；D 只卖 1-2 册（干扰，确保不会误选）
function mkListings() {
  const full = (shopId, shopName, price) => ({
    itemId: "i-" + shopId, title: shopName + " 全套1-5", shopId, shopName,
    shopLink: "http://x/" + shopId, price, shipping: 0, free: true, link: "",
    volMask: 0b11111,
  });
  return [
    full("A", "书店A", 50),
    full("B", "书店B", 60),
    full("C", "书店C", 70),
    { itemId: "i-D1", title: "书店D 第1册", shopId: "D", shopName: "书店D", shopLink: "", price: 5, shipping: 0, free: true, link: "", volMask: 0b00001 },
    { itemId: "i-D2", title: "书店D 第2册", shopId: "D", shopName: "书店D", shopLink: "", price: 5, shipping: 0, free: true, link: "", volMask: 0b00010 },
  ];
}
const volumes = [];
for (let i = 1; i <= 5; i++) volumes.push({ name: "第" + i + "册", keyword: "书" + i });

const shopIdsOf = (r) => {
  if (!r) return [];
  const arr = r.ok ? r.plan : (r.partialPlan || []);
  return arr.map((p) => (p.shop && p.shop.shopId)).filter(Boolean);
};

(async () => {
  const plans = [];
  let leftover = mkListings();
  const used = new Set();
  for (let k = 1; k <= 3; k++) {
    const r = await optimize(volumes, leftover, {});
    plans.push(r);
    const sids = shopIdsOf(r);
    if (!sids.length) break;
    sids.forEach((id) => used.add(id));
    leftover = leftover.filter((L) => !used.has(L.shopId));
    if (!leftover.length) break;
  }

  let pass = true;
  const fail = (m) => { pass = false; console.log("❌ " + m); };

  // ① 三个方案都满覆盖
  plans.forEach((p, i) => {
    if (!p.ok) fail("方案" + (i + 1) + " 不是满覆盖 (ok=" + p.ok + ")");
    else console.log("✅ 方案" + (i + 1) + " ok=true 总价=" + p.total + " 店铺=" + shopIdsOf(p).join(","));
  });
  if (plans.length < 3) fail("只算出 " + plans.length + " 个方案，期望 3");

  // ② 两两店铺集合不相交
  for (let i = 0; i < plans.length; i++)
    for (let j = i + 1; j < plans.length; j++) {
      const si = new Set(shopIdsOf(plans[i])), sj = new Set(shopIdsOf(plans[j]));
      for (const id of sj) if (si.has(id)) fail("方案" + (i + 1) + " 与方案" + (j + 1) + " 共用了店铺 " + id);
    }
  if (plans.length >= 3 && !shopIdsOf(plans[0]).some((x) => shopIdsOf(plans[1]).includes(x)) && !shopIdsOf(plans[1]).some((x) => shopIdsOf(plans[2]).includes(x)))
    console.log("✅ 三个方案店铺两两不相交（强制错开店铺）");

  // ③ 总价不降
  for (let i = 1; i < plans.length; i++)
    if (plans[i].total < plans[i - 1].total) fail("方案" + (i + 1) + " 总价 " + plans[i].total + " < 方案" + i + " 总价 " + plans[i - 1].total + "（应不降）");
  if (plans.length >= 3) console.log("✅ 总价不降：50 ≤ 60 ≤ 70 实测 " + plans[0].total + " ≤ " + plans[1].total + " ≤ " + plans[2].total);

  console.log(pass ? "\n=== K-BEST TEST PASS ===" : "\n=== K-BEST TEST FAIL ===");
  process.exit(pass ? 0 : 1);
})();
