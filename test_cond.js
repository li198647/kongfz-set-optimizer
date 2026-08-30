// v1.2.2 单测：parseCondition（出版社/年份筛选条件解析器）
// 直接抽取 user.js 里真实的 parseCondition 函数源码来测（与 test_extract 同思路：测真实代码）。
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'kongfz-set-optimizer.user.js'), 'utf8');

// 抽取 function parseCondition(str) { ... 匹配的闭合 }
function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('找不到 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('括号不匹配: ' + name);
}
const code = extractFn(SRC, 'parseCondition');
// eslint-disable-next-line no-eval
const parseCondition = (new Function(code + '\nreturn parseCondition;'))();

let pass = 0, fail = 0;
function T(name, got, exp) {
  const ok = got === exp;
  if (ok) pass++; else { fail++; console.log('  ✗ ' + name + ' → 期望 ' + JSON.stringify(exp) + ' 实得 ' + JSON.stringify(got)); }
}

// 1) 空串返回 null（不过滤）
T('空串返回null', parseCondition(''), null);
T('纯空格返回null', parseCondition('   '), null);

// 2) AND：长安出版社&1999
const f2 = parseCondition('长安出版社&1999');
T('AND-全满足入选', f2({ press: '长安出版社', pubYear: '1999-05' }), true);
T('AND-出版社不符剔除', f2({ press: '天地出版社', pubYear: '1999-05' }), false);
T('AND-年份不符剔除', f2({ press: '长安出版社', pubYear: '2000' }), false);
T('AND-缺字段剔除', f2({ press: '长安出版社', pubYear: '' }), false);

// 3) OR：1999|2000
const f3 = parseCondition('1999|2000');
T('OR-命中1999', f3({ press: 'x', pubYear: '1999-10' }), true);
T('OR-命中2000', f3({ press: 'x', pubYear: '2000' }), true);
T('OR-都不中剔除', f3({ press: 'x', pubYear: '2001' }), false);

// 4) 单条件（无符号）
const f4 = parseCondition('人民文学出版社');
T('单条件-出版社含子串', f4({ press: '人民文学出版社', pubYear: '2010' }), true);
T('单条件-出版社不含剔除', f4({ press: '商务印书馆', pubYear: '2010' }), false);

// 5) 子串匹配（出版社名片段即可）
const f5 = parseCondition('文学');
T('子串-“文学”命中“人民文学出版社”', f5({ press: '人民文学出版社', pubYear: '' }), true);

// 6) 大小写不敏感
const f6 = parseCondition('ABC&1999');
T('大小写-出版社小写命中大写', f6({ press: 'ABC出版社', pubYear: '1999' }), true);

// 7) 空白容忍：长安出版社 & 1999（带空格）
const f7 = parseCondition('长安出版社 & 1999');
T('空白容忍-等同无空格', f7({ press: '长安出版社', pubYear: '1999-05' }), true);
T('空白容忍-缺项剔除', f7({ press: '长安出版社', pubYear: '2000' }), false);

// 8) 混合：人民文学出版社&2010|商务印书馆&2012
const f8 = parseCondition('人民文学出版社&2010|商务印书馆&2012');
T('混合-第一组满足', f8({ press: '人民文学出版社', pubYear: '2010-03' }), true);
T('混合-第二组满足', f8({ press: '商务印书馆', pubYear: '2012' }), true);
T('混合-都不满足', f8({ press: '人民文学出版社', pubYear: '2012' }), false);

// 9) 缺少字段的对象不报错
T('缺对象字段不抛', (() => { try { return parseCondition('a')({}); } catch (e) { return 'throw'; } })(), false);

console.log('\nparseCondition 通过 ' + pass + ' / 共 ' + (pass + fail) + ' 项' + (fail ? ('，失败 ' + fail + ' 项') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
