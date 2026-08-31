/**
 * test_shopinputs.js —— 验证 v1.4.13 的 findShopFilterInputs() 定位逻辑
 *
 * 背景：孔网改版为 Element UI 后，店铺输入框没有 name 属性、id 还是动态生成的。
 * 新定位法 =「外层 .input-item 容器文字含"店铺" → 取其内所有 input.el-input__inner」。
 * F12 实地诊断发现：文字为"店铺"的那个容器里实测有 2 个 input（id 完全相同），
 * 所以必须返回**全部**并全部填入，而不是只取第一个。
 *
 * 本测试用 mock DOM 覆盖：主路径 / 隐藏框 / 兜底1 / 兜底2 / 去重 / 不误填其他筛选项。
 * 运行：node test_shopinputs.js
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'kongfz-set-optimizer.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// —— 从真实脚本里抽出 findShopFilterInputs 函数体（保证测的是线上代码，不是副本）——
const start = src.indexOf('function findShopFilterInputs()');
if (start === -1) { console.error('❌ 脚本里找不到 findShopFilterInputs()'); process.exit(1); }
const end = src.indexOf('\n  }', start);
const fnSrc = src.slice(start, end + 4);
if (!/function findShopFilterInputs\(\)/.test(fnSrc)) { console.error('❌ 函数体截取失败'); process.exit(1); }

// —— mock DOM 工具 ——
let uid = 0;
/** 造一个假 input：vis=true 表示页面可见（offsetParent 非 null） */
function mkInput(cls, id, vis) {
  return {
    __tag: 'input#' + (++uid),
    className: cls || 'el-input__inner',
    id: id || 'el-id-5923-6',
    value: '',
    offsetParent: vis === false ? null : {},           // null = 不可见
    getBoundingClientRect: () => ({ width: 38, height: 30, left: 719, top: 420 }),
    dispatchEvent() { return true; }
  };
}
/** 造一个假筛选容器：text=容器文字（如"店铺"/"作者"），inputs=其内的 input 列表 */
function mkBox(text, inputs, cls) {
  return {
    __tag: 'box:' + text,
    textContent: text,
    className: cls || 'input-item',
    querySelectorAll(sel) { return inputs.slice(); },
    querySelector(sel) { return inputs[0] || null; }
  };
}
/** 安装 mock document：boxes 按选择器关键字返回对应容器 */
function installDoc(boxesBySel, flatInputs) {
  global.document = {
    querySelectorAll(sel) {
      if (/input-item/i.test(sel)) return (boxesBySel.item || []).slice();
      if (/k-input|filter|screen|condition/i.test(sel)) return (boxesBySel.filter || []).slice();
      if (/placeholder/.test(sel)) return (flatInputs || []).slice();
      return [];
    }
  };
}

// —— 载入被测函数 ——
eval(fnSrc);   // 定义 findShopFilterInputs

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('=== findShopFilterInputs() 定位逻辑测试（v1.4.13）===\n');

// 用例1：主路径——店铺容器 2 个 input，同页还有作者/出版社容器，只能返回店铺的 2 个
console.log('[用例1] 主路径：店铺容器 2 个 input，另有 作者/出版社 容器');
{
  const s1 = mkInput('el-input__inner', 'el-id-5923-6');
  const s2 = mkInput('el-input__inner', 'el-id-5923-6');
  const author = mkInput('el-input__inner', 'el-id-5923-3');
  const press = mkInput('el-input__inner', 'el-id-5923-4');
  installDoc({ item: [mkBox('店铺', [s1, s2]), mkBox('作者', [author]), mkBox('出版社', [press])] });
  const got = findShopFilterInputs();
  check('返回 2 个（店铺容器内全部 input）', got.length === 2, '实际 ' + got.length);
  check('包含第 1 个店铺 input', got.indexOf(s1) !== -1);
  check('包含第 2 个店铺 input', got.indexOf(s2) !== -1);
  check('不含"作者"框的 input（不误填）', got.indexOf(author) === -1);
  check('不含"出版社"框的 input（不误填）', got.indexOf(press) === -1);
}

// 用例2：店铺框不可见（筛选条收起）→ 返回空，不落到兜底去误填别的框
console.log('\n[用例2] 店铺容器不可见（筛选条收起）');
{
  const hidden1 = mkInput('el-input__inner', 'x1', false);
  const hidden2 = mkInput('el-input__inner', 'x2', false);
  const other = mkInput('el-input__inner', 'x3');
  installDoc({ item: [mkBox('店铺', [hidden1, hidden2])], filter: [mkBox('商品名称', [other], 'k-input')] });
  const got = findShopFilterInputs();
  check('返回 0 个（不可见就不填，绝不乱填兜底框）', got.length === 0, '实际 ' + got.length);
}

// 用例3：兜底1——没有 .input-item 结构，改用 .k-input 容器文字含"店铺"
console.log('\n[用例3] 兜底1：.k-input 容器文字含"店铺"');
{
  const kInp = mkInput('el-input__inner', 'k1');
  installDoc({ item: [], filter: [mkBox('店铺', [kInp], 'k-input')] });
  const got = findShopFilterInputs();
  check('返回 1 个（走兜底命中）', got.length === 1, '实际 ' + got.length);
  check('命中的是店铺框', got[0] === kInp);
}

// 用例4：兜底2——只剩 placeholder 含"店铺"的输入框（老结构残留）
console.log('\n[用例4] 兜底2：placeholder 含"店铺"');
{
  const phInp = mkInput('kfz-old', 'p1');
  phInp.placeholder = '请输入店铺名';
  installDoc({ item: [], filter: [] }, [phInp]);
  const got = findShopFilterInputs();
  check('返回 1 个', got.length === 1, '实际 ' + got.length);
  check('命中的是 placeholder 框', got[0] === phInp);
}

// 用例5：去重——querySelectorAll 与 querySelector 拿到同一个 input 时不重复
console.log('\n[用例5] 去重：同一个 input 不被重复加入');
{
  const only = mkInput('el-input__inner', 'dup');
  installDoc({ item: [mkBox('店铺', [only])] });
  const got = findShopFilterInputs();
  check('返回 1 个（去重生效）', got.length === 1, '实际 ' + got.length);
}

// 用例6：完全没有"店铺"二字 → 返回空（不乱填）
console.log('\n[用例6] 页面上没有"店铺"筛选项');
{
  installDoc({ item: [mkBox('作者', [mkInput()]), mkBox('出版社', [mkInput()])], filter: [] });
  const got = findShopFilterInputs();
  check('返回 0 个', got.length === 0, '实际 ' + got.length);
}

console.log('\n———————————————————————');
console.log(fail === 0 ? `✅ 全部通过：${pass} 项` : `❌ 失败 ${fail} 项 / 通过 ${pass} 项`);
process.exit(fail === 0 ? 0 : 1);
