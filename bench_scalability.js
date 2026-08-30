// 合成可扩展性基准：模拟真实 225 店 / 323 条候选 场景，测 optimize() 真实耗时
const fs = require('fs');
const SRC = fs.readFileSync('./kongfz-set-optimizer.user.js', 'utf8');

const cfgMatch = SRC.match(/const CONFIG = \{[\s\S]*?\};/);
const cfgCode = cfgMatch ? cfgMatch[0].replace(/debug:\s*\w+/, 'debug: false') : 'const CONFIG = { debug: false };';
const yldMatch = SRC.match(/function yieldToBrowser\(\) \{[\s\S]*?\n  \}/);
const yldCode = yldMatch ? yldMatch[0] : 'function yieldToBrowser() { return new Promise(r => setTimeout(r, 0)); }';
const optMatch = SRC.match(/async function optimize\(volumes, listings, opts\) \{[\s\S]*?\n  \}\n/);
const optCode = optMatch[0];

const sandbox = [
  cfgCode,
  yldCode,
  'const _t = () => (typeof performance!=="undefined"?performance.now():Date.now());',
  optCode,
  'globalThis.__opt = optimize;',
].join('\n');
new Function(sandbox)();

const optimize = globalThis.__opt;

function buildListings(nShops, n) {
  const listings = [];
  let shopId = 0;
  // 1 店覆盖全部（模拟"世界五千年书店"那种全套店）
  listings.push({ shopId: shopId++, shopName: '全套店', shopLink: '', volMask: (1 << n) - 1, price: 70, free: true, shipping: 0 });
  // 其余店：每店 1-3 条，每条覆盖 1-3 册随机（店内共享 shopId）
  for (let s = 0; s < nShops - 1; s++) {
    const sid = shopId++;
    const cnt = 1 + (s % 3);
    for (let j = 0; j < cnt; j++) {
      let m = 0; const kc = 1 + (s % 3);
      for (let t = 0; t < kc; t++) { const v = Math.floor(Math.random() * n); m |= (1 << v); }
      listings.push({
        shopId: sid, shopName: '店' + s, shopLink: '',
        volMask: m,
        price: 5 + Math.random() * 50,
        free: (s % 4 === 0),
        shipping: 5 + Math.random() * 10,
      });
    }
  }
  return listings;
}

const n = 21;
const volumes = Array.from({ length: n }, (_, i) => i + 1);
const listings = buildListings(225, n);
console.log('场景：n=' + n + ' 店铺=' + (new Set(listings.map(l => l.shopId)).size) + ' 候选=' + listings.length);

const t0 = Date.now();
optimize(volumes, listings).then(r => {
  const dt = Date.now() - t0;
  console.log('⏱ 耗时 ' + dt + ' ms | ok=' + r.ok + ' total=' + (r.total != null ? r.total.toFixed(2) : '-') + ' plan居店=' + r.plan.length);
  if (r.ok) {
    let cov = 0;
    for (const sh of r.plan) for (const p of sh.listings) cov |= p.volMask;
    console.log('并集覆盖 1-' + n + ': ' + (((1 << n) - 1) === cov ? '✅通过' : '❌缺失'));
  }
}).catch(e => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
