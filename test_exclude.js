// 验证 v1.1.3 排除名单逻辑（GM API 用内存 mock 替代）
// 拷贝自 kongfz-set-optimizer.user.js v1.1.3 的 exKeyOf/loadExcluded/saveExcluded/
// isExcluded/addExcluded/removeExcluded/listExcluded，改动后需同步此文件。
const EXCLUDE_KEY = 'kfz_excluded';
let STORE = {};
const GM_getValue = (k, d) => (k in STORE ? STORE[k] : d);
const GM_setValue = (k, v) => { STORE[k] = v; };

function exKeyOf(L) {
  if (L && L.itemId != null && L.itemId !== '') return 'id:' + L.itemId;
  if (L && L.link) return 'lk:' + L.link;
  return '';
}
function loadExcluded() { try { return GM_getValue(EXCLUDE_KEY, {}) || {}; } catch (e) { return {}; } }
function saveExcluded(map) { try { GM_setValue(EXCLUDE_KEY, map); } catch (e) {} }
function isExcluded(L) {
  const m = loadExcluded();
  if (!m) return false;
  return !!(m['id:' + L.itemId] || (L.link && m['lk:' + L.link]));
}
function addExcluded(L) {
  const k = exKeyOf(L);
  if (!k) return false;
  const rec = { key: k, title: L.title || '', shopName: L.shopName || '', link: L.link || '', price: L.price || 0, ts: 1 };
  const m = loadExcluded();
  m[k] = rec;
  if (L.itemId != null && L.itemId !== '' && L.link) {
    const alt = 'lk:' + L.link;
    if (alt !== k) m[alt] = { ...rec, key: k, alias: true };
  }
  saveExcluded(m);
  return true;
}
function removeExcluded(key) {
  const m = loadExcluded();
  if (!m || !m[key]) return false;
  const rec = m[key];
  const primary = rec.alias ? rec.key : key;
  delete m[primary];
  for (const k of Object.keys(m)) { if (m[k] && m[k].key === primary && k !== primary) delete m[k]; }
  saveExcluded(m);
  return true;
}
function listExcluded() {
  const m = loadExcluded() || {};
  const out = [];
  for (const k of Object.keys(m)) { const r = m[k]; if (!r || r.alias) continue; out.push(r); }
  return out;
}

let pass = 0, fail = 0;
const T = (name, got, exp) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (ok) { pass++; } else { fail++; console.log('✗ FAIL: ' + name + ' 得到=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(exp)); }
};

// ★ 真实案例：百之耀书店《明朝那些事儿1-7大结局》（店主标题写错）
const bad = { itemId: 7928083174, title: '明朝那些事儿1-7大结局', shopName: '百之耀书店', price: 8, link: 'https://book.kongfz.com/750402/7928083174' };
const good = { itemId: 7928083175, title: '明朝那些事儿 第2册', shopName: '另一家', price: 12, link: 'https://book.kongfz.com/1/2' };
const noLink = { itemId: 999, title: '无链接条目', shopName: 'X店', price: 5, link: '' };

T('初始都未被排除', [isExcluded(bad), isExcluded(good)], [false, false]);
T('key 用 itemId 优先', exKeyOf(bad), 'id:7928083174');
T('无 itemId 时用 link', exKeyOf({ link: 'https://a/b' }), 'lk:https://a/b');
T('两者皆无返回空串', exKeyOf({}), '');

T('加入排除成功', addExcluded(bad), true);
T('加入后 isExcluded 为真', isExcluded(bad), true);
T('其他条目不受影响', isExcluded(good), false);
T('列表只显示 1 条（别名不重复）', listExcluded().length, 1);
T('列表标题正确', listExcluded()[0].title, '明朝那些事儿1-7大结局');

// 模拟检索过滤
const all = [bad, good, noLink];
const exMap = loadExcluded();
const kept = all.filter((L) => !(exMap['id:' + L.itemId] || (L.link && exMap['lk:' + L.link])));
T('过滤后剩 2 条', kept.length, 2);
T('被排除的已剔除', kept.some((L) => L.itemId === 7928083174), false);
T('保留的仍在', kept.some((L) => L.itemId === 7928083175), true);

// 恢复
T('恢复成功', removeExcluded('id:7928083174'), true);
T('恢复后 isExcluded 为假', isExcluded(bad), false);
T('恢复后列表为空', listExcluded().length, 0);
T('恢复后存储残留键已清空', Object.keys(loadExcluded()).length, 0);
T('重复恢复返回 false', removeExcluded('id:7928083174'), false);

// ★ 双键兜底：重搜后 itemId 变化、但链接相同 → 仍应命中
const byLink = { itemId: 555, title: '按链接排除', shopName: 'Y店', price: 3, link: 'https://book.kongfz.com/7/8' };
addExcluded(byLink);
T('主键为 id', Object.keys(loadExcluded()).includes('id:555'), true);
T('辅助键 lk 也已写入', Object.keys(loadExcluded()).includes('lk:https://book.kongfz.com/7/8'), true);
T('同链接不同 id 也能命中', isExcluded({ itemId: 777, link: 'https://book.kongfz.com/7/8' }), true);
T('不同链接不命中', isExcluded({ itemId: 777, link: 'https://book.kongfz.com/9/0' }), false);
T('列表仍只 1 条', listExcluded().length, 1);
// 用辅助键恢复，也应清干净
T('用辅助键恢复成功', removeExcluded('lk:https://book.kongfz.com/7/8'), true);
T('用辅助键恢复后存储清空', Object.keys(loadExcluded()).length, 0);
T('恢复后不再命中', isExcluded(byLink), false);

// 只有链接、无 itemId 的条目
const onlyLink = { itemId: null, title: '仅链接', shopName: 'Z店', price: 9, link: 'https://book.kongfz.com/3/4' };
T('仅链接条目可加入', addExcluded(onlyLink), true);
T('仅链接条目可命中', isExcluded({ itemId: 123, link: 'https://book.kongfz.com/3/4' }), true);
T('无 itemId 无 link 返回 false', addExcluded({}), false);

console.log('\n通过 ' + pass + ' / 共 ' + (pass + fail) + ' 项' + (fail ? ('，失败 ' + fail + ' 项') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
