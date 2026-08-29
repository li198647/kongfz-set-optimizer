// 验证 v1.1.4 标题排除关键词逻辑（GM API 用内存 mock）
// 拷贝自 kongfz-set-optimizer.user.js v1.1.4 的 loadExRules/saveExRules/matchExRules/parseExRules
const EXRULE_KEY = 'kfz_exrules';
let STORE = {};
const GM_getValue = (k, d) => (k in STORE ? STORE[k] : d);
const GM_setValue = (k, v) => { STORE[k] = v; };

function loadExRules(bookName) {
  try {
    const all = GM_getValue(EXRULE_KEY, {}) || {};
    const r = all[String(bookName || '')];
    return Array.isArray(r) ? r : [];
  } catch (e) { return []; }
}
function saveExRules(bookName, rules) {
  try {
    const all = GM_getValue(EXRULE_KEY, {}) || {};
    const k = String(bookName || '');
    const clean = (rules || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (clean.length) all[k] = clean; else delete all[k];
    GM_setValue(EXRULE_KEY, all);
  } catch (e) {}
}
function matchExRules(title, rules) {
  if (!rules || !rules.length) return null;
  const t = String(title || '');
  for (const r of rules) { if (!r) continue; if (t.indexOf(r) >= 0) return r; }
  return null;
}
function parseExRules(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

let pass = 0, fail = 0;
const T = (name, got, exp) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (ok) { pass++; } else { fail++; console.log('✗ FAIL: ' + name + ' 得到=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(exp)); }
};

const BOOK_A = '明朝那些事儿', BOOK_B = '文化服装讲座';
// ★ 用户真实案例：店主把标题写错成「1-7大结局」
const bad1 = { itemId: 7928083174, title: '明朝那些事儿1-7大结局', price: 8 };
const good1 = { itemId: 111, title: '明朝那些事儿 第2册', price: 12 };
const good2 = { itemId: 222, title: '明朝那些事儿 第5册', price: 15 };

// ===== 1. 解析输入 =====
T('解析多行规则', parseExRules('1-7大结局\n全套包邮'), ['1-7大结局', '全套包邮']);
T('去空行与首尾空格', parseExRules('  1-7大结局  \n\n  全套 \n'), ['1-7大结局', '全套']);
T('空输入返回空数组', parseExRules(''), []);
T('null 输入返回空数组', parseExRules(null), []);

// ===== 2. 按书名隔离（用户选择：只对当前这套书生效） =====
T('初始该书无规则', loadExRules(BOOK_A), []);
saveExRules(BOOK_A, ['1-7大结局']);
T('A 书规则已存', loadExRules(BOOK_A), ['1-7大结局']);
T('B 书不受影响（隔离）', loadExRules(BOOK_B), []);
saveExRules(BOOK_B, ['合售']);
T('B 书有自己的规则', loadExRules(BOOK_B), ['合售']);
T('A 书仍是自己的规则', loadExRules(BOOK_A), ['1-7大结局']);
T('两书规则互不干扰', [loadExRules(BOOK_A), loadExRules(BOOK_B)], [['1-7大结局'], ['合售']]);
// 换回 A 书 → 只读到 A 的规则（模拟“换书名自动切换”）
T('切换回 A 只看到 A 规则', loadExRules(BOOK_A), ['1-7大结局']);

// ===== 3. 严格匹配（用户选择：原样连续子串） =====
const rulesA = loadExRules(BOOK_A);
T('★真实案例命中', matchExRules(bad1.title, rulesA), '1-7大结局');
T('正常标题不命中', matchExRules(good1.title, rulesA), null);
// 严格：中间插空格就匹配不上（这是刻意选的“严格匹配”语义）
T('严格-插空格不命中', matchExRules('明朝那些事儿1-7 大结局', rulesA), null);
T('严格-完全不含不命中', matchExRules('明朝那些事儿 第3册', rulesA), null);
T('空规则不命中', matchExRules(bad1.title, []), null);
T('空标题不命中', matchExRules('', rulesA), null);

// 多条规则任一命中
const multi = ['全套包邮', '1-7大结局', '缺页'];
T('多条-命中第二条', matchExRules('明朝那些事儿1-7大结局', multi), '1-7大结局');
T('多条-命中第一条', matchExRules('明朝 全套包邮', multi), '全套包邮');
T('多条-都不含', matchExRules('明朝 第3册', multi), null);

// 特殊字符按字面处理（用 indexOf 不是正则，元字符安全）
T('正则元字符按字面-命中', matchExRules('价格 1.5 元', ['1.5']), '1.5');
T('正则元字符不误伤', matchExRules('价格 125 元', ['1.5']), null);
T('括号字面匹配', matchExRules('书(上册)', ['(上册)']), '(上册)');

// ===== 4. 算价阶段过滤（模拟 runWith 的过滤） =====
const filterByRules = (listings, rules) =>
  listings.filter((L) => !matchExRules(L.title, rules));
const all = [bad1, good1, good2];
T('过滤前 3 条', all.length, 3);
const kept = filterByRules(all, rulesA);
T('过滤后剩 2 条', kept.length, 2);
T('写错标题的被剔除', kept.some((L) => L.itemId === 7928083174), false);
T('正常条目保留', kept.map((L) => L.itemId), [111, 222]);

// ===== 5. 删除规则 =====
saveExRules(BOOK_A, loadExRules(BOOK_A).filter((r) => r !== '1-7大结局'));
T('删除后 A 无规则', loadExRules(BOOK_A), []);
T('删除后存储不留空壳', Object.keys(GM_getValue(EXRULE_KEY, {})).includes(BOOK_A), false);
T('删除后不再命中', matchExRules(bad1.title, loadExRules(BOOK_A)), null);
T('删除后过滤回 3 条', filterByRules(all, loadExRules(BOOK_A)).length, 3);
T('B 书规则不受删除影响', loadExRules(BOOK_B), ['合售']);

// 存空数组 = 删除该书名条目
saveExRules(BOOK_B, []);
T('存空数组即清除 B', loadExRules(BOOK_B), []);
T('存储已完全清空', GM_getValue(EXRULE_KEY, {}), {});


// ===== 6. 集成级：模拟 runWith 的过滤管线（验证重算幂等 + 规则/名单组合） =====
// runWith 收到原始 listings，过滤后算价，并把【原始集合】交回 bindExcludeEvents，
// 因此反复重算（改规则/删规则/恢复条目）不应越过滤越少。
const exMapMock = {}; // 手动排除名单（简化：只按 id）
const pipeline = (data, rules, exMap) => {
  const hitRules = [], hitManual = [];
  const effective = (data.listings || []).filter((L) => {
    const r = matchExRules(L.title, rules);
    if (r) { hitRules.push(L); return false; }
    if (exMap['id:' + L.itemId] || (L.link && exMap['lk:' + L.link])) { hitManual.push(L); return false; }
    return true;
  });
  // 关键：交回给 bindExcludeEvents 的是原始未过滤集合
  return { effective, hitRules, hitManual, passedBack: { volumes: data.volumes, listings: data.listings } };
};

const volumes = [{ name: '第1册' }, { name: '第2册' }, { name: '第3册' }];
const dataset = {
  volumes,
  listings: [
    { itemId: 1, title: '明朝那些事儿1-7大结局', price: 8 },   // 命中规则
    { itemId: 2, title: '明朝那些事儿 第2册', price: 12 },
    { itemId: 3, title: '明朝那些事儿 第3册', price: 15 },
    { itemId: 4, title: '明朝那些事儿 全套包邮', price: 40 },   // 命中规则
  ],
};
const rules2 = ['1-7大结局', '全套包邮'];
const r1 = pipeline(dataset, rules2, exMapMock);
T('组合过滤-剩 2 条', r1.effective.length, 2);
T('组合过滤-规则命中 2 条', r1.hitRules.length, 2);
T('组合过滤-名单命中 0 条', r1.hitManual.length, 0);
T('交回的是原始 4 条', r1.passedBack.listings.length, 4);

// 幂等：用“交回的集合”连续重算 5 次，结果应始终一致
let cur = r1.passedBack, stable = true;
for (let i = 0; i < 5; i++) {
  const r = pipeline(cur, rules2, exMapMock);
  if (r.effective.length !== 2) stable = false;
  cur = r.passedBack;
}
T('★重算 5 次幂等（不越过滤越少）', stable, true);
T('★重算后仍是原始 4 条', cur.listings.length, 4);

// 规则 + 手动名单同时作用
exMapMock['id:2'] = { key: 'id:2' }; // 手动再排除第2册
const r2 = pipeline(dataset, rules2, exMapMock);
T('规则+名单-只剩 1 条', r2.effective.length, 1);
T('规则+名单-规则命中 2', r2.hitRules.length, 2);
T('规则+名单-名单命中 1', r2.hitManual.length, 1);
delete exMapMock['id:2'];

// 删除规则后恢复
const r3 = pipeline(dataset, ['1-7大结局'], exMapMock);
T('删掉一条规则后剩 3 条', r3.effective.length, 3);
const r4 = pipeline(dataset, [], exMapMock);
T('删光规则后恢复 4 条', r4.effective.length, 4);

console.log('\n通过 ' + pass + ' / 共 ' + (pass + fail) + ' 项' + (fail ? ('，失败 ' + fail + ' 项') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
