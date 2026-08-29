const fs = require('fs');
const d = JSON.parse(fs.readFileSync('list.json','utf8'));
const items = d.data.itemResponse.list;
const BASE = '李永乐老师给孩子讲物理';
const N = 9;

// 从 user.js 截取 extractVolumes 及其依赖（normText 等）
const src = fs.readFileSync('kongfz-set-optimizer.user.js','utf8');
const i = src.indexOf('  function normText(s) {');
const j = src.indexOf('  // 搜索单个关键词');
eval(src.slice(i, j));

console.log('共 ' + items.length + ' 个 listing，逐个跑 extractVolumes(n=' + N + ')：\n');
let stuck = [];
items.forEach((it, idx) => {
  const t0 = Date.now();
  let res, threw=null;
  try { res = [...extractVolumes(it.title, BASE, N)].sort((a,b)=>a-b); }
  catch(e){ threw = e.message; res = 'THROW'; }
  const dt = Date.now() - t0;
  const flag = dt > 300 ? '⚠️ SLOW/可能卡' : (dt > 50 ? '⏱ 偏慢' : '✅');
  console.log(flag + ' #' + (idx+1) + ' ' + String(dt).padStart(6) + 'ms  ' + (threw?('THROW: '+threw):JSON.stringify(res)));
  console.log('        «' + it.title + '»');
  if (dt > 300) stuck.push({idx:idx+1, title:it.title, dt});
});
console.log('\n卡死/极慢候选数: ' + stuck.length);
if (stuck.length) console.log(JSON.stringify(stuck, null, 2));
