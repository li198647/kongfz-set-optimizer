// ==UserScript==
// @name         孔网合集跨店最低价凑单助手
// @namespace    https://workbuddy.cn
// @version     1.4.4
// @description 浏览孔夫子旧书网某套合集时，自动跨店检索各单册价格与运费，计算出能凑齐整套的最低总价跨店组合方案。
// @author      WorkBuddy
// @match       https://*.kongfz.com/*
// @match       https://kongfz.com/*
// @connect     search.kongfz.com
// @grant       GM_xmlhttpRequest
// @grant       GM_addStyle
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 配置区：如搜索接口/参数有变动，主要改这里即可
   * ============================================================ */
  const CONFIG = {
    // 孔网 JSON 搜索接口（已实测可用，无需登录）
    apiBase: 'https://search.kongfz.com/pc-gw/search-web/client/pc/product/keyword/list',
    referer: 'https://search.kongfz.com/',
    // 每个分册最多抓取的搜索页数（每页 pageSize 条）。调大=选项更多但更慢
    pagesPerVolume: 3,
    pageSize: 40,
    // 两次搜索之间的间隔(ms)，礼貌一点，别太快
    delayMs: 350,
    // 同一个分册最多保留多少条候选（按价格升序截断，控制规模）
    maxListingsPerVolume: 80,
    // 部分接口对非大陆 IP 会软屏蔽，可填入 userArea（如北京 1006000000）；留空一般也行
    userArea: '',
    // 品相筛选：留空=不限；可填最低品相等级，如 '八五品'
    minQuality: '',
    // 仅看包邮
    onlyFreeShip: false,
    // 严格匹配：要求“基础书名”在标题中紧贴出现（不允许中间插入“函授”等无用字）
    exactContiguous: true,
    // 基础书名（紧贴匹配用）。留空则自动取“分册关键词去掉末尾数字”，例如“文化服装讲座1”→“文化服装讲座”
    baseKeyword: '',
    // 标题若包含以下任意词直接剔除（如把“函授”插入版排除）
    blockWords: ['函授'],
    // v1.1.12 调试模式：true 时在 console 打印每步状态（gmFetch onload/onerror/ontimeout/hardTimer、册搜索起止），
    //   用户把日志贴回来就能定位"第 N 册卡住"是 hang / timeout / 限流 / 慢响应 中哪一种。
    debug: true,
  };

  // 模块级状态（当前整套的基础书名，用于紧贴匹配）
  let STATE = { base: '', aborted: false };

  // 版本号：每次改动都必须 +0.0.1（全局记忆“发版铁律”，最高优先级）
  const SCRIPT_VERSION = '1.4.4';

  /* ============================================================
   * 工具函数
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const ce = (tag, props, children) => {
    const el = document.createElement(tag);
    if (props) Object.assign(el, props);
    if (children) (Array.isArray(children) ? children : [children]).forEach((c) => el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return el;
  };
  const yuan = (n) => '¥' + (Math.round(n * 100) / 100).toFixed(2);

  // 品相等级量化（用于筛选）
  const QUALITY_RANK = {
    '全新': 100, '准新品': 98, '几乎全新': 98, '九五品': 95, '九品': 90,
    '八五品': 85, '八品': 80, '七五品': 75, '七品': 70, '六五品': 65,
    '六品': 60, '五品': 50, '四五品': 45, '四品': 40, '三五品': 35,
    '三品': 30, '二品': 20, '一品': 10, '不限': 0,
  };
  const qualityRank = (t) => (QUALITY_RANK[t] != null ? QUALITY_RANK[t] : 50);

  /* ============================================================
   * 网络请求（用 Tampermonkey 的 GM_xmlhttpRequest 绕过跨域限制）
   * v1.1.8: 加 setTimeout 硬超时兜底——某些网络环境（VPN 切换/代理异常）下
   *   GM_xmlhttpRequest 既不触发 onerror 也不触发 ontimeout，Promise 会永久挂起，
   *   导致 gatherListings 在第 N 册卡死。25s 硬超时强制 reject。
   * ============================================================ */
  /**
   * v1.1.13: 让出主线程（不阻塞 UI），且**不受后台标签 setTimeout 节流影响**。
   * 背景：v1.1.9 用 `await new Promise(r => setTimeout(r, 0))` 做 yield 防"页面无响应"，
   *   但 Chrome 对后台/失焦标签的 setTimeout 会节流到 1000ms，超过 5 分钟更会
   *   intensive throttling（60 秒才执行一次）。第 9 册 40 个 listing → 4 次 yield × 60s = 4 分钟假死，
   *   表现就是"8 册能完成、9 册卡死"（实测日志：12 次请求全部 200 OK，卡在 vol 9 DONE 之前）。
   * 方案：优先用 MessageChannel（走 postMessage 任务队列，不受 timer 节流），不可用时回退 setTimeout。
   */
  function yieldToBrowser() {
    return new Promise((resolve) => {
      try {
        if (typeof MessageChannel !== 'undefined') {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => { try { ch.port1.close(); ch.port2.close(); } catch (e) {} resolve(); };
          ch.port2.postMessage(0);
          return;
        }
      } catch (e) { /* MessageChannel 不可用 → 落到下面的 setTimeout 兜底 */ }
      setTimeout(resolve, 0);
    });
  }

  function gmFetch(url, headers) {
    return new Promise((resolve, reject) => {
      let done = false;
      const _t0 = performance.now();
      const _shortUrl = url.length > 100 ? url.slice(0, 100) + '…' : url;
      if (CONFIG.debug) console.log('[kfz] gmFetch START t=' + _t0.toFixed(0) + 'ms  url=' + _shortUrl);
      const finish = (fn) => { if (done) return; done = true; clearTimeout(hardTimer); fn(); };
      const hardTimer = setTimeout(() => {
        const dt = (performance.now() - _t0).toFixed(0);
        if (CONFIG.debug) console.log('[kfz] gmFetch HARD TIMEOUT ' + dt + 'ms  url=' + _shortUrl);
        finish(() => reject(new Error('请求硬超时 25s（网络异常）')));
      }, 25000);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: headers || {},
          timeout: 20000,
          onload: (r) => {
            const dt = (performance.now() - _t0).toFixed(0);
            if (CONFIG.debug) console.log('[kfz] gmFetch onload ' + dt + 'ms  status=' + r.status + '  len=' + (r.responseText ? r.responseText.length : 0) + '  url=' + _shortUrl);
            finish(() => {
              if (r.status >= 200 && r.status < 300) resolve(r.responseText);
              else reject(new Error('HTTP ' + r.status));
            });
          },
          onerror: () => {
            const dt = (performance.now() - _t0).toFixed(0);
            if (CONFIG.debug) console.log('[kfz] gmFetch onerror ' + dt + 'ms  url=' + _shortUrl);
            finish(() => reject(new Error('网络错误')));
          },
          ontimeout: () => {
            const dt = (performance.now() - _t0).toFixed(0);
            if (CONFIG.debug) console.log('[kfz] gmFetch ontimeout (20s) ' + dt + 'ms  url=' + _shortUrl);
            finish(() => reject(new Error('请求超时')));
          },
        });
      } catch (e) {
        // 极端情况：GM_xmlhttpRequest 自身抛同步异常（极少见，比如 URL 非法），兜底
        if (CONFIG.debug) console.log('[kfz] gmFetch GM THROW ' + e.message);
        finish(() => reject(new Error('GM 异常：' + e.message)));
      }
    });
  }

  // 把一条孔网商品 JSON 归一化
  function normalizeItem(it) {
    let shipping = 0;
    let free = false;
    const postage = it.postage;
    if (it.freeShip === true) free = true;
    if (postage) {
      if (postage.sellerPayFreight === true) free = true;
      const list = postage.shippingList || [];
      if (list.length) {
        const fees = list.map((s) => Number(s.shippingFee) || 0);
        const min = Math.min.apply(null, fees);
        if (min <= 0) free = true;
        else shipping = min;
      }
    }
    return {
      itemId: it.itemId,
      title: it.title || '',
      press: it.press || '',            // v1.2.2: 出版社（用于“出版社/年份筛选”条件框）
      pubYear: it.pubDateText || '',    // v1.2.2: 出版日期文本（如 "2019-10" / "2017" / "不详"）
      price: Number(it.price) || 0,
      shopId: it.shopId,
      shopName: it.shopName || ('店铺' + it.shopId),
      shopLink: (it.shopLink && it.shopLink.pc) || ('https://shop.kongfz.com/' + it.shopId),
      link: (it.link && it.link.pc) || '',
      qualityText: it.qualityText || '',
      free,
      shipping,
      isSoldOut: !!it.isSoldOut,
      volMask: 0, // 由调用方按分册赋值
    };
  }

  /* ---------- 排除（黑名单）持久化 ----------
   * 用户可在结果行点“🚫排除”把某条商品（店主写错标题等）拉黑，
   * 下次检索自动跳过；被排除条目在结果区最下方折叠展示，可“恢复”。
   * 存储结构：{ [key]: { title, shopName, link, price, ts } }，key 优先 itemId，其次商品链接。
   */
  const EXCLUDE_KEY = 'kfz_excluded';
  function exKeyOf(L) {
    if (L && L.itemId != null && L.itemId !== '') return 'id:' + L.itemId;
    if (L && L.link) return 'lk:' + L.link;
    return '';
  }
  function loadExcluded() {
    try { return GM_getValue(EXCLUDE_KEY, {}) || {}; } catch (e) { return {}; }
  }
  function saveExcluded(map) { try { GM_setValue(EXCLUDE_KEY, map); } catch (e) {} }
  function isExcluded(L) {
    const m = loadExcluded();
    if (!m) return false;
    return !!(m['id:' + L.itemId] || (L.link && m['lk:' + L.link]));
  }
  // 同时写入 itemId 与 link 两个键（重搜后 itemId 可能变化，靠 link 兜底命中）；
  // 两个键指向同一条记录（key 取主键），移除时一并清掉，避免残留半条。
  function addExcluded(L) {
    const k = exKeyOf(L);
    if (!k) return false;
    const rec = {
      key: k, title: L.title || '', shopName: L.shopName || '',
      link: L.link || '', price: L.price || 0, ts: Date.now(),
    };
    const m = loadExcluded();
    m[k] = rec;
    // 辅助键：同一商品的另一种标识，也指向同一记录（用 key 反指，列表展示时按 key 去重）
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
    // 清掉所有指向该主键的辅助键
    for (const k of Object.keys(m)) {
      if (m[k] && m[k].key === primary && k !== primary) delete m[k];
    }
    saveExcluded(m);
    return true;
  }
  // 列表展示用的记录（去掉别名项，按主键去重）
  function listExcluded() {
    const m = loadExcluded() || {};
    const out = [];
    for (const k of Object.keys(m)) {
      const r = m[k];
      if (!r || r.alias) continue;
      out.push(r);
    }
      return out;
  }
  // 释放与某书名相关的手动排除（标题包含该书名，归一化紧贴匹配），返回释放条数。
  // 用于“🔓 解除相关书名排除”按钮：清掉当前整套书在历史里累积的手动排除，让它们下次重新进运算。
  function releaseRelatedExcluded(book) {
    const nb = normText(book || '');
    if (nb.length < 2) return 0;
    const list = listExcluded();
    let n = 0;
    for (const e of list) {
      if (normText(e.title).indexOf(nb) >= 0) { removeExcluded(e.key); n++; }
    }
    return n;
  }
  // 清空全部手动排除条目（所有书），返回清空条数。用于“🧹 一键清空列表”按钮。
  function clearAllExcluded() {
    const list = listExcluded();
    for (const e of list) removeExcluded(e.key);
    return list.length;
  }

  /* ---------- 标题排除关键词（按书名隔离 + 严格子串匹配） ----------
   * 用户填一个字符串（如「1-7大结局」），凡是标题里出现该串的商品全部不参与比价，
   * 用于批量排除“店主把标题写错”的那类商品。
   * · 按书名隔离：规则挂在“整套书名”下，换一套书自动切换/清空，互不干扰。
   * · 严格匹配：标题必须原样连续包含该字符串（不做去空格/忽略大小写等宽松处理）。
   * 存储结构：kfz_exrules = { [书名]: [关键词, ...] }
   */
  const EXRULE_KEY = 'kfz_exrules';
  // 书名 → 规则数组（取不到返回空数组）
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
      if (clean.length) all[k] = clean; else delete all[k]; // 无规则则整条删除，不留空壳
      GM_setValue(EXRULE_KEY, all);
    } catch (e) {}
  }
  // 严格匹配：标题原样连续包含任一关键词 → 返回命中的关键词，否则 null
  function matchExRules(title, rules) {
    if (!rules || !rules.length) return null;
    const t = String(title || '');
    for (const r of rules) {
      if (!r) continue;
      if (t.indexOf(r) >= 0) return r;
    }
    return null;
  }
  // 把文本框内容（每行一个）解析为规则数组
  function parseExRules(text) {
    return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }

  // v1.2.2: “出版社/年份筛选”条件框解析器（纯函数，便于单测）
  // 语法：顶层按 | 拆成“或(OR)”组；组内按 & 拆成“且(AND)”项；每项在 (press + ' ' + pubYear) 中
  //       做不区分大小写的子串匹配。例：
  //         "长安出版社&1999"      → 出版社含“长安出版社” 且 年份含“1999”
  //         "1999|2000"            → 年份含 1999 或含 2000
  //         "人民文学出版社"        → 单条件：出版社/年份含该串即可
  // 返回谓词 (L)=>bool；空串返回 null（表示不过滤）。
  function parseCondition(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    const orGroups = s.split('|')
      .map((g) => g.split('&').map((t) => t.trim()).filter(Boolean))
      .filter((g) => g.length);
    if (!orGroups.length) return null;
    return (L) => {
      const press = (L && L.press) || '';
      const year = (L && L.pubYear) || '';
      const hay = (press + ' ' + year).toLowerCase();
      return orGroups.some((group) => group.every((term) => hay.indexOf(term.toLowerCase()) >= 0));
    };
  }

  // 归一化：去掉空白与标点，仅保留中文/数字/字母，便于做“紧贴”匹配
  function normText(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[^\u4e00-\u9fff\u3400-\u4dbf0-9A-Za-z]/g, '');
  }

  // 标题过滤：剔除黑名单词；要求基础书名在标题中“紧贴”出现（不允许插入无用字）
  function titlePassesFilter(title, base) {
    if (CONFIG.blockWords && CONFIG.blockWords.length) {
      for (const w of CONFIG.blockWords) if (w && title.indexOf(w) >= 0) return false;
    }
    if (CONFIG.exactContiguous) {
      const b = normText(base || '');
      if (b && !normText(title).includes(b)) return false;
    }
    return true;
  }

  // 从标题解析出它覆盖的卷（1..n 集合）。核心原则：以“显式列出的卷号”为准，绝不凭“合售/全套”等词空泛推断。
  // 支持：单卷(讲座1/（1）/第1册)、并列卷(2、8 / 2,3,4,5,8 / 2 3 4 5 6 7 8)、
  //       拼接卷号(讲座1234 → 1,2,3,4)、范围(1-8册/1一8)、中文数字(八册)、
  //       以及“缺X/差X/少X/无X”标注的残卷套(如“1-8差第4册”→ 1,2,3,5,6,7,8)。
  function extractVolumes(title, base, n) {
    const nb = normText(base || '');
    const tRaw = String(title || '');
    // ★ 在解析卷号之前，先把“非卷号噪声”从标题清掉：
    //   ① 价格/包邮等促销噪声：被【】包裹且含 元/￥/$/包邮/块 的店铺价签，以及裸价格（14.77元/￥14.77/15元包邮）。
    //      孔网标题里“14.77元包邮”这种价签常被误当成卷号 1、4、7（如“女装篇3，【14.77元包邮】”只卖第3册却显示1/3/4/7），必须剔除。
    //   ② 柜号/架号是纯噪声（数字+号(柜|架|书架) 或 反向写法），详见下方正则（“柜号是无用信息，不要加入思考”）。
    //   以上清理都早于“去空格”：避免“卷号 空格 柜号”数字粘连吞掉真卷号（如“1、2 33号柜”→“1、233号柜”）。
    let tClean = tRaw
      .replace(/【[^】]*(?:元|￥|\$|包邮|块|RMB)[^】]*】/g, ' ')   // 去【…元/包邮…】店铺价签块
      .replace(/\[[^\]]*(?:元|￥|\$|包邮|块|RMB)[^\]]*\]/g, ' ')   // 半角[]同理
      .replace(/\d+(?:\.\d+)?\s*(?:元|块|￥|\$|RMB)\s*(?:包邮|包顺丰|不包邮)?/g, ' ') // 裸价格
      .replace(/\d+\s*品/g, ' ')                                      // 数字+品（如 9品/95品 是品相，非卷号）
      .replace(/(^|[^0-9])\d+[-~—]?\d*\s*号\s*(?:柜|架|书架)?/g, '$1 ') // 50-1号柜 / 33号柜 / 3号架
      .replace(/(?:柜|架|书架)\s*\d+[-~—]?\d*/g, ' ')                    // 柜50 / 架3 / 书架12
      .replace(/\d+\s*(?:柜|架|书架)/g, ' ');                            // 3柜 / 3架（无“号”）
    //   ③ 库存号/货架号括号（含英文字母或罗马数字，如"（存ⅩBD19一1）""（A区3架）""（B12）"）：纯噪声，整括号剔除。
    //      这是"前面的显式卷号优先、括号里的库存/货架号是无用数据"原则的体现——绝不参与卷号判定。
    //      同时也消除了"19一1"被范围识别当成"19到1"整段误拉全套的隐患。
    tClean = tClean.replace(/[（(][^（）()]*[A-Za-zⅩⅪⅫⅠⅡⅢⅣⅤⅥⅦⅧⅨ][^（）()]*[)）]/g, ' ');
    //   ④ 日期格式 YYYY-M-D / YYYY/M/D / YYYY.M.D，以及不完整的"年月" YYYY-M / YYYY/M / YYYY.M（年月日的强特征：4位-1~2位[-1~2位]），整段剔除。
    //      应对"台海出版社 2019-07-01"——若不剔，2019-07 会被(B)范围识别成"7到2019"加出7/8，07/01 会被(C)当单卷。
    //      也应对"… 2020-9 9787571311742503 …"（v1.1.15 真凶）："2020-9"是年月残片(非完整 YYYY-M-D 故旧正则漏清)，
    //        去空格后紧邻 ISBN 拼成 "2020-978…" → (B)误判卷范围 → addRange(2020,10^16) 主线程死循环卡死。
    //        扩展为可选第三段的 YYYY-M 后，(C)里 "2020-9" 的月份 "9" 也不再被当卷号。
    //        安全：卷范围两端都是 ≤30 的小数，"4位-1~2位"不可能是真实卷号，绝不误伤 1-9 之类。
    tClean = tClean.replace(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/g, ' ');
    //   ⑤ v1.1.10 库位号/编号：字母+数字-数字（如 "C11-3"、"A2-5"、"B12-7"）是书架库位或内部编号，纯噪声。
    //      应对"李永乐老师给孩子讲物理 09物理 … C11-3"——若不剔，(B)范围会把 "11-3" 识别成"11到3"→ addRange(3,11)
    //      误加 3..n（截图误判成"3到9册"）。注意：正则要求"字母+数字"开头，纯数字范围（1-8缺3）不受影响。
    tClean = tClean.replace(/[A-Za-z]\s*\d+\s*[-~—]\s*\d+/g, ' ');
    const t = tClean.replace(/\s+/g, '');   // 去空格后用于范围(B)解析（已无柜号/价格/库存号括号/日期/库位号）
    const tSpace = tClean;                  // 保留空格，用于(C)逐段抽取——空格是天然分隔符，避免“卷号 空格 大数”粘连(如“3 3000例”→“33000”)
    const nt = normText(tClean);            // 仅中文/数字/字母，用于过滤与全套检测
    const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    const vols = new Set();
    let hasExplicit = false;
    const add = (v) => { if (v >= 1 && v <= n) { vols.add(v); hasExplicit = true; } };
    // ★ 防御：卷范围跨度必须有上限。孔网合集最多 n(≤30) 册，真实范围跨度不可能过千。
    //   历史故障：标题含 "2020-9"(年月残片，④只清 YYYY-M-D 双分隔符故漏清) 紧邻 ISBN "9787571311742503"，
    //   去空格后拼接成 "2020-99787571311742503"，被 (B) 误判成卷范围 → addRange(2020, 10^16) →
    //   主线程死循环(~10^16 次) 卡死整个脚本。任何端点超 n 或跨度>1000 必是脏数据，直接拒绝。
    const addRange = (a, b) => {
      if (a > b) [a, b] = [b, a];
      if (b - a > 1000) return;
      for (let i = a; i <= b; i++) add(i);
    };

    // (A) 第X册 / 第X、Y册（逐个取）
    const diAll = nt.matchAll(/第\s*([0-9]+|[一二三四五六七八九十])\s*册?/g);
    for (const m of diAll) { const c = m[1]; add(CN[c] || +c); }

    // (B) 范围 A-B（分隔符 - ~ — 到 至 一），t 已剔除柜号，避免“50-1号柜”被当卷范围
    const mRange = t.match(/(\d+)\s*[-~—到至一]\s*(\d+)/);
    if (mRange) addRange(+mRange[1], +mRange[2]);

    // (C) 书名之后的"卷号列表"：按 、，,.;·/ （）()【】[] 号 等切分，逐段抽取数字。
    //     两位及以上数字串：整数为有效卷号(如10)则取之，否则按单卷拆开(1234→1,2,3,4)；
    //     数字后紧跟 开/版/印/年/期/本/册 视为非卷号(16开、共8本、全5册、第1版)。
    //   ★ v1.1.5 新增"无效数字"剔除 + 升序检查（用户反馈"店主写错/ISBN/日期"）：
    //     1) 前导零数字无效：01/007 这种带前导零的不算卷号（日期末位"01"就是这种）
    //     2) 单个 run 长度超过总本数（册数 n）→ 整串丢弃：9787516822890504（16位，n=7）整串不参与解析
    //     3) per-tok 升序：一段连续字符里的数字若不严格递增（ISBN 拆出 9,7,8,7...）→ 整段丢
    //     4) 跨 tok 整体升序：跨多段的显式列举整体不严格递增（8,7,1,4,2,5）→ 整组丢
    const idx = nb ? tSpace.indexOf(nb) : 0;
    const seg = idx >= 0 ? tSpace.slice(idx + (nb ? nb.length : 0)) : tSpace;
    const toks = seg.split(/[、，,.;·\/（）()【】\[\]号]/).map((s) => s.trim()).filter(Boolean);
    // 严格递增：每项 > 前一项。空/单元素不查（天然保留）
    const isAsc = (arr) => { for (let i = 1; i < arr.length; i++) if (arr[i] <= arr[i - 1]) return false; return true; };
    const segCand = []; // 跨 tok 收集的"按原文顺序的"卷号候选，供整体升序检查用
    for (const tok of toks) {
      const runs = tok.match(/[0-9]+/g) || [];
      const tokCand = [];
      // 用 lastIdx 跟踪上一个 run 末尾，避免 indexOf 总是返回第一个匹配位置（v1.1.5 修）
      let lastIdx = 0;
      for (const run of runs) {
        // 1) 前导零：长度>2 的（007/0012）视为无效编号跳过；
        //    但 2 位补零（01-09）视为卷号保留——如 "09物理"=第9册（v1.1.10 修）。
        //    日期里的 01/07 已由 ④ 整段剔除，不会单独漏到这里。
        if (/^0\d/.test(run) && run.length > 2) continue;
        // 2) run 长度超过总本数 → 整串丢弃（只丢这个 run 本身，不影响同 tok 内其他 run；如 "1,2,3 978..." 的 1,2,3 应保留）
        if (run.length > n) continue;
        const p = tok.indexOf(run, lastIdx);
        if (p < 0) continue;
        lastIdx = p + run.length;
        // v1.1.10: "第X册/卷"的数字（前一个字符是"第"）直接 add，不进 segCand 参与升序检查。
        //   否则同一 tok 里 "09物理"(卷9) 与 "第2册"(卷2) 会被收集成 [9,2] 判乱序整段丢弃（实测丢卷9）。
        //   注意不能简单 continue——"第3、5册" 的 (A) 正则去标点后会贪婪匹配成"第35册"(35 超范围不 add)，
        //   若这里再跳过 3 就全丢了，所以必须自己 add 一次。
        if (tok[p - 1] === '第') { const dv = +run; if (dv >= 1 && dv <= n) add(dv); continue; }
        const afterCh = tok[p + run.length] || '';
        if (/[开版印年期刊例]/u.test(afterCh)) continue;            // 16开 / 第1版 / 1980年 / 3000例 等 → 非卷号
        // 数字后紧跟 本/册：仅当它是"数量词"时才跳过——判断只看该数字的"紧邻上下文"：
        //   前一个是 共/全/差/缺/少/无/没/总/售，或 后接 (数字?)本/册+合售/售卖（跳过 run 后残留的前导数字）。
        //   例如 "3本合售" 的 '3' → next2Clean='本合售' → 命中 → 跳过（数量词）。
        if (afterCh === '本' || afterCh === '册') {
          const prevCh = tok[p - 1] || '';
          const next2 = tok.slice(p + run.length).replace(/^[0-9]+/, '');
          const isCount = /[共全差缺少无没总售]/u.test(prevCh) || /^(本|册)?(合售|合卖|售卖|全套)/u.test(next2);
          if (isCount) continue;
        }
        if (/^[0-9]{2,}$/.test(run)) {
          const whole = +run;
          if (whole >= 1 && whole <= n) tokCand.push(whole);
          else { const chars = run.split('').map(Number); if (chars.every((d) => d >= 1 && d <= n)) chars.forEach((d) => tokCand.push(d)); }
        } else {
          const v = +run; if (v >= 1 && v <= n) tokCand.push(v);
        }
      }
      // 3) per-tok 升序检查（单元素天然保留）
      if (tokCand.length >= 2 && !isAsc(tokCand)) continue;
      segCand.push(...tokCand);
    }
    // 4) 跨 tok 整体升序检查：整体不严格递增 → 整组不加入（"8,7,1,4,2,5" 这种罕见降序列举视为无效数字）
    if (segCand.length >= 2 && !isAsc(segCand)) {
      // 整组丢：不清空 segCand（保持已收集顺序以备可能的诊断），但不 add 任何
    } else {
      for (const v of segCand) add(v);
    }

    // (D) 残卷套：缺/差/少/无/没 X → 移除对应卷号。
    //     支持“缺5,7”（逗号/顿号分隔多卷，如“1-8缺5,7”=卖1,2,3,4,6,8）、“缺3-5”（范围缺）、“缺3”（单卷）、
    //     以及中文数字/“第X册”写法（差一册=缺1、差第2册=缺2、缺三=缺3）。
    //     关键：逗号分隔的多个缺卷必须整体抓取，否则只会删第一个（如“缺5,7”漏删7 → 误判7也在卖）。
    const missMarkRe = /[缺少无差没]/g;
    let mpos;
    while ((mpos = missMarkRe.exec(t)) !== null) {
      const after = t.slice(mpos.index + 1);
      const listM = after.match(/^\s*(?:[一二三四五六七八九十]|第)?\s*册?\s*([0-9]+(?:[-~—][0-9]+)?(?:[\s、，,]+[0-9]+(?:[-~—][0-9]+)?)*)/);
      if (!listM) continue;
      const items = listM[1].split(/\s*[、，, ]\s*/).map((s) => s.trim()).filter(Boolean);
      for (const it of items) {
        if (/^[0-9]+[-~—][0-9]+$/.test(it)) {
          let [a, b] = it.split(/[-~—]/).map(Number);
          if (a > b) [a, b] = [b, a];
          for (let i = a; i <= b; i++) vols.delete(i);          // 范围缺：缺3-5 → 删 3,4,5
        } else if (/^[0-9]+$/.test(it)) {
          const d = +it;
          if (d >= 1 && d <= n) vols.delete(d);                 // 单卷缺：删 5
          else if (/^[0-9]{2,}$/.test(it)) {                    // 两位数按单卷拆分（缺35→去3、5）
            const chars = it.split('').map(Number);
            if (chars.every((c) => c >= 1 && c <= n)) chars.forEach((c) => vols.delete(c));
          }
        }
      }
    }
    // 中文数字卷号缺失（如“差一册”=缺第1册）；“差一册6”里“一”是数量词而非卷号，需确认“册”后不是数字才删
    const missCn = /[缺少无差没]\s*(?:第)?\s*([一二三四五六七八九十])\s*册?/g;
    let mm;
    while ((mm = missCn.exec(t)) !== null) {
      let end = mm.index + mm[0].length;
      if (t[end] === '册') end++;            // 跳过可选的“册”
      const after = t[end];
      if (after && /[0-9]/.test(after)) continue; // “差一册6”：一是数量词，真正缺的是 6（由 missMarkRe 处理）
      const v = CN[mm[1]]; if (v >= 1 && v <= n) vols.delete(v);
    }

    // (E) 仅在“显式列出了卷号”时才采纳；若没有任何卷号，再看是否声明“全套/全部/全X册(X==n)”
    if (!hasExplicit) {
      vols.clear();
      if (/(全[套部]|全部)/.test(nt)) { for (let i = 1; i <= n; i++) vols.add(i); }
      else {
        const cnM = nt.match(/全([一二三四五六七八九十百])[册本]/); // 全八册/全五本
        if (cnM) { const cnt = CN[cnM[1]]; if (cnt === n) for (let i = 1; i <= n; i++) vols.add(i); }
      }
    }
    return vols;
  }

  // 搜索单个关键词，返回归一化条目数组（volMask 未填）。pages 可覆盖默认每册页数
  async function searchKeyword(keyword, onLog, pages) {
    const out = [];
    const pagesToFetch = pages != null ? pages : CONFIG.pagesPerVolume;
    const pageSize = CONFIG.pageSize;
    if (CONFIG.debug) console.log('[kfz] searchKeyword START keyword="' + keyword + '" pages=' + pagesToFetch);
    for (let p = 1; p <= pagesToFetch; p++) {
      if (STATE.aborted) throw new Error('用户终止了计算');   // v1.3.1: 翻页间隙即可中止
      let url = CONFIG.apiBase + '?keyword=' + encodeURIComponent(keyword) +
        '&page=' + p + '&pageSize=' + pageSize;
      if (CONFIG.userArea) url += '&userArea=' + CONFIG.userArea;
      let txt;
      try {
        txt = await gmFetch(url, { Referer: CONFIG.referer, Accept: 'application/json' });
      } catch (e) {
        if (onLog) onLog('搜索“' + keyword + '”失败：' + e.message);
        break;
      }
      let j;
      try { j = JSON.parse(txt); } catch (e) { break; }
      const list = (j && j.data && j.data.itemResponse && j.data.itemResponse.list) || [];
      if (!list.length) break;
      // v1.1.9: 每 10 个 listing 让出主线程一次，避免长任务撑爆导致浏览器"页面无响应"
      //   extractVolumes 同步执行，60+ 个 listing 累积可达数百毫秒～秒级，浏览器 5-10s 无响应判定
      for (let li = 0; li < list.length; li++) {
        const it = list[li];
        if (it.isSoldOut) continue;
        if (CONFIG.onlyFreeShip && !(it.freeShip === true || (it.postage && it.postage.sellerPayFreight === true))) continue;
        if (CONFIG.minQuality && qualityRank(it.qualityText) < qualityRank(CONFIG.minQuality)) continue;
        // 严格紧贴匹配：剔除“函授”等插入版，要求基础书名紧贴出现
        if (!titlePassesFilter(it.title, STATE.base || keyword)) continue;
        out.push(normalizeItem(it));
        if ((li + 1) % 10 === 0) await yieldToBrowser();   // v1.1.13: 改用 MessageChannel yield
      }
      if (list.length < pageSize) break;
      if (p < pages) await sleep(CONFIG.delayMs);
    }
    return out;
  }

  // 收集所有分册的候选条目（按 itemId 去重并合并覆盖卷；支持跨卷打包/残卷套）
  async function gatherListings(volumes, onProgress, onLog) {
    const n = volumes.length;
    const byId = new Map();
    const perVolumeCount = new Array(n).fill(0);
    const base = STATE.base || volumes[0].keyword;
    const _tAll = performance.now();
    if (CONFIG.debug) console.log('[kfz] gatherListings START n=' + n + ' base="' + base + '"');

    // 排除（黑名单）统计
    const excludedMap = loadExcluded();
    let excludedCount = 0;

    // 把一条商品按标题解析覆盖卷后并入去重表；返回是否成功纳入
    //   v1.1.14: 加 debug 日志——卡死时"最后一条 merge START"的标题就是罪魁（extractVolumes 死循环/极慢）
    let mergeSeq = 0;
    const merge = (it) => {
      const _seq = ++mergeSeq;
      const _ttl = String(it && it.title || '').slice(0, 30);
      if (CONFIG.debug) console.log('[kfz] merge #' + _seq + ' START id=' + (it && it.itemId) + ' title="' + _ttl + '"');
      // 已被用户排除的条目直接跳过（店主写错标题等情况）
      if (excludedMap && (excludedMap['id:' + it.itemId] || (it.link && excludedMap['lk:' + it.link]))) {
        excludedCount++;
        if (CONFIG.debug) console.log('[kfz] merge #' + _seq + ' SKIP(excluded)');
        return false;
      }
      const _t0 = performance.now();
      const vols = extractVolumes(it.title, base, n);
      if (CONFIG.debug) {
        const _dt = performance.now() - _t0;
        if (_dt > 50) console.log('[kfz] merge #' + _seq + ' SLOW ' + _dt.toFixed(0) + 'ms title="' + _ttl + '"');
      }
      if (!vols || vols.size === 0) {
        if (CONFIG.debug) console.log('[kfz] merge #' + _seq + ' NO-VOLS');
        return false;
      }
      let mask = 0;
      vols.forEach((x) => { if (x >= 1 && x <= n) mask |= 1 << (x - 1); });
      if (!mask) return false;
      const prev = byId.get(it.itemId); // 跨卷打包/残卷套可能在多册搜索中都被命中 → 按 itemId 合并
      if (prev) prev.volMask |= mask;
      else { it.volMask = mask; byId.set(it.itemId, it); }
      return true;
    };

    // 1) 基础书名搜索：捕获“全套/1-8册”等跨卷打包（这类标题不一定含“讲座N”）
    if (base) {
      const baseItems = await searchKeyword(base, onLog, CONFIG.pagesPerVolume);
      for (const it of baseItems) merge(it);
    }

    // 2) 逐册搜索：捕获单册与残卷套，并补全覆盖（每册抓 1 页足够，已由基础搜索兜底）
    //    v1.1.8: 单册 try/catch，失败 logf 提示后继续下一册，不让某次网络/解析异常阻塞整轮
    //    v1.1.9: 册间 yield，让浏览器在册与册之间能响应 UI（避免"页面无响应"）
    //    v1.1.11: 册间 sleep(CONFIG.delayMs)（350ms 默认）防反爬——之前只有 setTimeout(0)≈0ms，
    //             10 册连续快请求会触发孔网限流/反爬（用户实测每次卡在第 8 册）
    for (let i = 0; i < n; i++) {
      if (STATE.aborted) throw new Error('用户终止了计算');   // v1.3.1: 逐册间隙即可中止
      const _t0 = performance.now();
      if (CONFIG.debug) console.log('[kfz] vol ' + (i + 1) + '/' + n + ' START keyword="' + volumes[i].keyword + '"  t=' + _t0.toFixed(0));
      let items = [];
      try {
        items = await searchKeyword(volumes[i].keyword, onLog, 1);
      } catch (e) {
        if (onLog) onLog('⚠ 第 ' + (i + 1) + ' 册《' + volumes[i].name + '》搜索失败：' + e.message + '（跳过本册）');
        if (CONFIG.debug) console.log('[kfz] vol ' + (i + 1) + ' FAIL ' + (performance.now() - _t0).toFixed(0) + 'ms  err=' + e.message);
      }
      let acc = 0;
      for (const it of items) if (merge(it)) acc++;
      if (CONFIG.debug) console.log('[kfz] vol ' + (i + 1) + ' DONE ' + (performance.now() - _t0).toFixed(0) + 'ms  raw=' + items.length + ' added=' + acc);
      if (onProgress) onProgress(i, n, volumes[i].name, acc);
      perVolumeCount[i] = items.length;
      if (i < n - 1) {
        await yieldToBrowser();            // v1.1.13: 改用 MessageChannel yield（不受后台节流）
        await sleep(CONFIG.delayMs);       // 再 sleep 350ms 防反爬（延迟本来就要等，用 setTimeout 合理）
        if (CONFIG.debug) console.log('[kfz] inter-volume sleep ' + CONFIG.delayMs + 'ms done');
      }
    }
    if (CONFIG.debug) console.log('[kfz] gatherListings DONE total=' + (performance.now() - _tAll).toFixed(0) + 'ms');

    if (excludedCount > 0 && onLog) onLog('已按“排除名单”跳过 ' + excludedCount + ' 条（可在本页最下方折叠区恢复）');
    const listings = [...byId.values()];
    return { listings, perVolumeCount };
  }

  /* ============================================================
   * 优化器（纯函数，已用 Node 单元测试验证）
   * 输入：volumes=[{name}], listings=[{price,shopId,shopName,shopLink,link,
   *        qualityText,free,shipping,volMask}], opts
   * 输出：{ok,total,plan:[{shop,listings,shipping,subtotal}],missing:[idx]}
   * ============================================================ */
  // === OPTIMIZER START ===
  // v1.1.16：位掩码 DP 主线程冻死修复
  //   1) 改用 Float64Array / Int32Array typed array，降内存 + GC 压力；
  //   2) 店铺内 DP 把 afP/nfP 的 Array.concat 全换掉，改用 afPrev/afIdx/nfPrev/nfIdx/nfFromAf 五个 Int32/Uint8 双亲引用；
  //   3) 改为 async function，在店铺内 listings 循环、configMap 构建、全局 DP 主循环中按需 yieldToBrowser，让位主线程；
  //   4) 加 CONFIG.debug 进度日志（入口 / 单店 DP 完成 / 全局 DP mask 进度 / 全局 DP 完成总耗时）。
  //   复杂度降阶：单店从 O(items²·2ⁿ) → O(items·2ⁿ)；全局从 O(shops·2²ⁿ·configs) → 同阶但配合 yield 不再冻死浏览器。
  async function optimize(volumes, listings, opts) {
    opts = opts || {};
    const n = volumes.length;
    if (n === 0) return { ok: false, error: '没有分册' };

    const _t = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = CONFIG.debug ? _t() : 0;
    if (CONFIG.debug) console.log('[kfz] opt START n=' + n + ' listings=' + listings.length);

    // 1) 按店铺分组
    const shops = new Map();
    for (const L of listings) {
      if (!L || !L.volMask) continue;
      if (L.price == null || L.price < 0) continue;
      let s = shops.get(L.shopId);
      if (!s) {
        s = { shopId: L.shopId, shopName: L.shopName, shopLink: L.shopLink, listings: [] };
        shops.set(L.shopId, s);
      }
      s.listings.push(L);
    }

    // 2) 每个店铺内：双状态 DP（局部 mask 降维 —— 维数 = 本店涉及册数，而非全局 n）
    //    关键优化：原先每店都开 2^n 维(≈209万)的 8 个 typed array(≈64MB)，225 店→≈14GB 分配把 GC 拖垮，单店 6-10s。
    //    降维后单店维数 = 2^(本店册数)，通常 2^3=8，内存从 64MB→几百字节，单店 <1ms，整体提速上万倍；运费逻辑不变(仍 af/nf 双状态，一店只收一次运费)。
    const N1 = 1 << n;
    const bigN = n >= 10;                          // 大 n 时启用 yield（避免小输入无谓让位）
    const shopConfigs = [];
    for (const s of shops.values()) {
      // —— 局部索引：把本店涉及的全局卷位映射到 0..ln-1，实现降维 ——
      const localVols = [];                          // localVols[li] = 全局卷索引 i（卷 i 对应 (1<<i)）
      const gToL = new Int32Array(n).fill(-1);       // 全局卷索引 → 局部索引
      for (const L of s.listings) {
        let gm = L.volMask;
        while (gm) {
          const bit = gm & -gm;
          const gi = 31 - Math.clz32(bit);           // 全局卷索引（无浮点误差）
          if (gToL[gi] < 0) { gToL[gi] = localVols.length; localVols.push(gi); }
          gm &= gm - 1;
        }
      }
      const ln = localVols.length;
      if (ln === 0) continue;
      const LN1 = 1 << ln;

      let shopShip = 0, hasNonFree = false;
      for (const L of s.listings) {
        if (!L.free && L.shipping > 0) { hasNonFree = true; if (shopShip === 0 || L.shipping < shopShip) shopShip = L.shipping; }
      }
      if (!hasNonFree) shopShip = 0;

      // 局部维 typed array（维数 LN1，通常极小：本店册数 3 → 2^3=8 状态）
      const af = new Float64Array(LN1);
      const nf = new Float64Array(LN1);
      for (let k = 0; k < LN1; k++) { af[k] = Infinity; nf[k] = Infinity; }
      af[0] = 0;

      const afPrev = new Int32Array(LN1);
      const afIdx  = new Int32Array(LN1);
      const nfPrev = new Int32Array(LN1);
      const nfIdx  = new Int32Array(LN1);
      const nfFromAf = new Uint8Array(LN1);
      afPrev.fill(-1); afIdx.fill(-1); nfPrev.fill(-1); nfIdx.fill(-1);

      const items = s.listings;
      // 预计算每个 listing 的局部 mask（把全局 volMask 投影到局部位）
      const localMask = new Int32Array(items.length);
      for (let i = 0; i < items.length; i++) {
        let gm = items[i].volMask, lm = 0;
        while (gm) {
          const bit = gm & -gm;
          const gi = 31 - Math.clz32(bit);
          lm |= (1 << gToL[gi]);
          gm &= gm - 1;
        }
        localMask[i] = lm;
      }

      const shopStart = CONFIG.debug ? _t() : 0;

      for (let i = 0; i < items.length; i++) {
        const lm = localMask[i], p = items[i].price;
        if (items[i].free) {
          for (let mask = LN1 - 1; mask >= 0; mask--) {
            if (af[mask] !== Infinity) {
              const nm = mask | lm, c = af[mask] + p;
              if (c < af[nm]) { af[nm] = c; afPrev[nm] = mask; afIdx[nm] = i; }
            }
            if (nf[mask] !== Infinity) {
              const nm = mask | lm, c = nf[mask] + p;
              if (c < nf[nm]) { nf[nm] = c; nfPrev[nm] = mask; nfIdx[nm] = i; nfFromAf[nm] = 0; }
            }
          }
        } else {
          for (let mask = LN1 - 1; mask >= 0; mask--) {
            if (af[mask] !== Infinity) {
              const nm = mask | lm, c = af[mask] + p + shopShip;
              if (c < nf[nm]) { nf[nm] = c; nfPrev[nm] = mask; nfIdx[nm] = i; nfFromAf[nm] = 1; }
            }
            if (nf[mask] !== Infinity) {
              const nm = mask | lm, c = nf[mask] + p;
              if (c < nf[nm]) { nf[nm] = c; nfPrev[nm] = mask; nfIdx[nm] = i; nfFromAf[nm] = 0; }
            }
          }
        }
        if (bigN && (i & 0xF) === 0xF) {
          if (STATE.aborted) throw new Error('用户终止了计算');   // v1.3.1: 本店内部 DP 每 16 条即查中止
          await yieldToBrowser();
        }
      }

      // 回溯（局部空间，返回的 picks 是全局 listing 对象，正确）
      const backtrack = (which, mask) => {
        const out = [];
        let m = mask, w = which;
        while (m !== 0) {
          const Prev = w === 'af' ? afPrev : nfPrev;
          const Idx  = w === 'af' ? afIdx  : nfIdx;
          const pm = Prev[m], idx = Idx[m];
          if (pm < 0 || idx < 0) break;
          out.push(items[idx]);
          if (w === 'nf' && nfFromAf[m] === 1) w = 'af';
          m = pm;
        }
        return out.reverse();
      };

      // 局部 mask → 全局 mask（把本店覆盖的局部位还原成全局卷位）
      const localToGlobal = (lm) => {
        let gm = 0, m = lm, pos = 0;
        while (m) { if (m & 1) gm |= (1 << localVols[pos]); m >>= 1; pos++; }
        return gm;
      };

      const configMap = new Map();
      for (let mask = 1; mask < LN1; mask++) {
        let cost, which;
        if (af[mask] <= nf[mask]) { if (af[mask] < Infinity) { cost = af[mask]; which = 'af'; } else continue; }
        else { if (nf[mask] < Infinity) { cost = nf[mask]; which = 'nf'; } else continue; }
        configMap.set(localToGlobal(mask), { cost, picks: backtrack(which, mask) });
        // LN1 通常极小，无需让位；仅超大规模单店（LN1>65536）才 yield
        if (bigN && LN1 > 65536 && (mask & 0xFFFF) === 0xFFFF) {
          if (STATE.aborted) throw new Error('用户终止了计算');   // v1.3.1: 本店 configMap DP 中途可中止
          await yieldToBrowser();
        }
      }

      if (CONFIG.debug) {
        console.log('[kfz] opt shop="' + (s.shopName || '').slice(0, 12) + '" items=' + items.length +
          ' localN=' + ln + ' configs=' + configMap.size + ' dt=' + (_t() - shopStart).toFixed(0) + 'ms');
      }
      shopConfigs.push({ shop: s, configs: configMap, shopShip });
    }

    // 3) 0/1 背包式 DP（每个店铺至多使用一次），状态 = 已覆盖的卷集合
    const FULL = N1 - 1;
    const dp = new Float64Array(N1);
    for (let k = 0; k < N1; k++) dp[k] = Infinity;
    dp[0] = 0;
    const parent = new Int32Array(N1); parent.fill(-1);
    const choice = new Array(N1).fill(null);

    let shopIdx = 0;
    const inChg = new Uint8Array(N1);   // 复用标记，记录本店被更新的 mask
    for (const sc of shopConfigs) {
      // v1.3.1: 每店 loop 顶先查 aborted（不在此 yield，避免 N×4ms 性能累加退步），确保按"终止计算"后即刻停止
      if (STATE.aborted) throw new Error('用户终止了计算');
      shopIdx++;
      const nd = Float64Array.from(dp);
      const nparent = Int32Array.from(parent);
      // v1.1.17-FIX: nchoice 必须从上一轮 choice 继承！直接 fill(null) 会丢 nchoice[FULL] → 回溯 0 居店。
      const nchoice = Array.from(choice);
      // 预计算每个配置的全局 mask 与 base 价（去掉内层上亿次 reduce 调用）
      const cfgArr = [];
      for (const [sm, cfg] of sc.configs.entries()) {
        let base = 0;
        for (const p of cfg.picks) base += p.price;
        cfgArr.push({ sm, cost: cfg.cost, picks: cfg.picks, base });
      }
      if (CONFIG.debug) console.log('[kfz] opt global shop ' + shopIdx + '/' + shopConfigs.length + ' configs=' + cfgArr.length);

      inChg.fill(0);
      const changed = [];
      let updates = 0;
      let lastYield = _t();
      let chk = 0;
      // 密集顺序遍历全部 2^n 状态：V8 对定长顺序循环优化极好，比显式 active 列表（破坏缓存局部性）更快
      for (let mask = 0; mask < N1; mask++) {
        const dpM = dp[mask];
        if (dpM === Infinity) continue;
        for (let k = 0; k < cfgArr.length; k++) {
          const e = cfgArr[k];
          const nmask = mask | e.sm;
          const cand = dpM + e.cost;
          if (cand < nd[nmask]) {
            nd[nmask] = cand;
            nparent[nmask] = mask;
            nchoice[nmask] = { shop: sc.shop, picks: e.picks, ship: e.cost - e.base };
            updates++;
            if (!inChg[nmask]) { inChg[nmask] = 1; changed.push(nmask); }
          }
        }
        // 全局 DP 让位 + 中止检查：每 65536 次裸读 STATE.aborted（~0.5-1ms 即响应，开销可忽略），命中即抛错；
        // 真 yield 仍按 >50ms 时间预算触发（避免热循环里无谓 yield，保持 v1.1.18 性能铁律）
        if (bigN && (++chk & 0xFFFF) === 0) {
          if (STATE.aborted) throw new Error('用户终止了计算');
          if (_t() - lastYield > 50) {
            lastYield = _t();
            if (CONFIG.debug) console.log('[kfz] opt global shop ' + shopIdx + ' mask=' + mask + '/' + N1 + ' updates=' + updates);
            await yieldToBrowser();
          }
        }
      }
      // 只提交被本店改变的 mask（避免每店全量 2^n 写回）
      for (let i = 0; i < changed.length; i++) { const m = changed[i]; dp[m] = nd[m]; parent[m] = nparent[m]; choice[m] = nchoice[m]; }
      if (CONFIG.debug) console.log('[kfz] opt global shop ' + shopIdx + ' DONE changed=' + changed.length + ' updates=' + updates);
      if (bigN) await yieldToBrowser();
    }

    if (CONFIG.debug) {
      console.log('[kfz] opt global DONE dt=' + (_t() - t0).toFixed(0) + 'ms shops=' + shopConfigs.length);
    }

    if (dp[FULL] === Infinity) {
      // 找出未被任何店铺覆盖的卷
      const covered = new Set();
      for (const L of listings) { let m = L.volMask; while (m) { const v = Math.log2(m & -m); covered.add(Math.round(v)); m &= m - 1; } }
      const missing = [];
      for (let i = 0; i < n; i++) if (!covered.has(i)) missing.push(i);
      // v1.2.6: 凑不齐整套时，找"已凑到最多分册"且"该分册数下总价最低"的部分覆盖 mask 回溯展示。
      // 教训：原先只用 dp[m]<bestCost 筛，会被"1店1册¥21"这种极小总价误导，丢掉 7 册的更优方案。
      let bestMask = 0, bestCount = 0, bestCost = Infinity;
      for (let m = 1; m < N1; m++) {
        if (dp[m] === Infinity) continue;
        // popcount：m 里置位的个数 = 此方案覆盖的卷数
        let cnt = 0; { let t = m; while (t) { cnt++; t &= t - 1; } }
        if (cnt > bestCount || (cnt === bestCount && dp[m] < bestCost)) {
          bestCount = cnt; bestCost = dp[m]; bestMask = m;
        }
      }
      let partialPlan = null;
      if (bestMask !== 0 && bestCost < Infinity) {
        const pp = []; let pm = bestMask;
        while (pm !== 0) {
          const c = choice[pm];
          if (!c) break;
          const subtotal = c.picks.reduce((a, b) => a + b.price, 0) + (c.ship || 0);
          pp.push({ shop: c.shop, listings: c.picks, shipping: c.ship || 0, subtotal });
          pm = parent[pm];
        }
        pp.reverse();
        partialPlan = pp;
      }
      return {
        ok: false, error: '无法凑齐整套', missing,
        partialPlan, partialMask: bestMask, partialTotal: bestCost < Infinity ? bestCost : null,
        partialCount: bestCount
      };
    }

    // 4) 回溯方案
    const plan = [];
    let m = FULL;
    while (m !== 0) {
      const c = choice[m];
      if (!c) break;
      const subtotal = c.picks.reduce((a, b) => a + b.price, 0) + (c.ship || 0);
      plan.push({ shop: c.shop, listings: c.picks, shipping: c.ship || 0, subtotal });
      m = parent[m];
    }
    plan.reverse();
    return { ok: true, total: dp[FULL], plan };
  }
  // === OPTIMIZER END ===

  // 朴素对比：每个卷都从最便宜的店铺买（各自算运费，可能多家）
  function naivePlan(volumes, listings) {
    const n = volumes.length;
    let total = 0;
    const usedShops = new Set();
    for (let i = 0; i < n; i++) {
      let best = null;
      for (const L of listings) if ((L.volMask & (1 << i)) && (!best || L.price < best.price)) best = L;
      if (best) { total += best.price + (best.free ? 0 : best.shipping); usedShops.add(best.shopId); }
    }
    return total;
  }

  /* ============================================================
   * 界面
   * ============================================================ */
  function buildPanel() {
    GM_addStyle(`
      #kfz-panel{position:fixed;top:80px;left:0;right:auto;z-index:2147483647;width:360px;max-height:88vh;
        display:flex;flex-direction:column;overflow:hidden;
        background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        font:13px/1.5 -apple-system,'Microsoft YaHei',sans-serif;color:#222;}
      #kfz-panel *{box-sizing:border-box}
      #kfz-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#c8161d;color:#fff;
        border-radius:10px 10px 0 0;cursor:move;font-weight:700;flex:0 0 auto;white-space:nowrap}
      #kfz-head .compact-tag{display:none;align-items:center}
      /* 收起态：仅剩标题栏，底部也需圆角；面板变窄不再堵视线 */
      #kfz-panel.kfz-collapsed{width:auto;max-width:200px}
      #kfz-panel.kfz-collapsed #kfz-head{border-radius:10px;padding:8px 10px;gap:6px;opacity:1}
      #kfz-panel.kfz-collapsed #kfz-head .long{display:none}
      #kfz-panel.kfz-collapsed #kfz-head .compact-tag{display:inline-flex}
      #kfz-panel.kfz-collapsed #kfz-head #kfz-fill{display:none}
      #kfz-head .x{cursor:pointer;opacity:.85;font-weight:400}
      #kfz-head #kfz-fill{font-size:12px;padding:1px 6px;margin-right:6px;border:1px solid rgba(255,255,255,.65);border-radius:4px}
      #kfz-head #kfz-fill:hover{background:rgba(255,255,255,.2);opacity:1}
      #kfz-result-wrap{flex:0 0 auto;max-height:60vh;overflow:auto;border-bottom:1px solid #eee;background:#fffdf3}
      #kfz-result-wrap:empty{display:none}        /* 没结果时整个区域隐藏，不占空间 */
      #kfz-body{padding:12px;overflow:auto;flex:1 1 auto;min-height:0}
      #kfz-panel label{display:block;margin:8px 0 3px;color:#555;font-size:12px}
      #kfz-panel input,#kfz-panel textarea,#kfz-panel select{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}
      #kfz-panel textarea{height:120px;resize:vertical;font-family:inherit}
      #kfz-panel .row{display:flex;gap:8px}
      #kfz-panel .row>*{flex:1}
      #kfz-panel button{margin-top:8px;padding:8px 10px;border:0;border-radius:6px;background:#c8161d;color:#fff;cursor:pointer;font-size:13px}
      #kfz-panel button.sec{background:#f0f0f0;color:#333}
      #kfz-panel button.warn{background:#fff;color:#c8161d;border:1px solid #c8161d}
      #kfz-panel button.warn:hover{background:#fdecec}
      /* v1.4.1: 方案切换条（第一/二/三方案，比主按钮小） */
      #kfz-panel .kfz-plan-switch{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 12px 2px}
      #kfz-panel .kfz-plan-switch .kfz-ps-label{font-size:12px;color:#666}
      #kfz-panel .kfz-plan-switch .ps{font-size:11px;padding:3px 11px;border:1px solid #c8161d;background:#fff;color:#c8161d;border-radius:14px;cursor:pointer}
      #kfz-panel .kfz-plan-switch .ps:hover{background:#fdecec}
      #kfz-panel .kfz-plan-switch .ps.active{background:#c8161d;color:#fff}
      #kfz-panel .kfz-plan-switch .ps:disabled{opacity:.4;cursor:not-allowed;border-color:#ccc;color:#999;background:#f5f5f5}
      #kfz-panel .kfz-plan-switch .ps.loading{opacity:.6;cursor:default;border-style:dashed}
      #kfz-panel button.warn.stopping{background:#ff8c00;color:#fff;border-color:#ff8c00}  /* v1.3.2: 按下后置“终止中”高亮态，告知用户已生效 */
      #kfz-panel button:hover{opacity:.9}
      #kfz-log{margin-top:8px;max-height:120px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px 8px;font-size:12px;color:#444;white-space:pre-wrap}
      #kfz-result{margin:0}                       /* 顶部留白由 wrap 提供 */
      #kfz-result .total{font-size:16px;font-weight:700;color:#c8161d;margin:8px 12px 4px}
      #kfz-result table{width:100%;border-collapse:collapse;font-size:12px}
      #kfz-result th,#kfz-result td{border:1px solid #eee;padding:5px 6px;text-align:left;vertical-align:top}
      #kfz-result th{background:#f6f6f6}
      #kfz-result .shop{color:#c8161d;font-weight:700}
      #kfz-result .muted{color:#999}
      .kfz-tip{font-size:11px;color:#999;margin:4px 12px 8px}
      /* 结果行内的“排除”小按钮 */
      #kfz-result .kfz-itemrow{margin:2px 0;line-height:1.6}
      #kfz-result .kfz-ex{display:inline-block;margin:0 0 0 6px;padding:0 5px;line-height:16px;
        background:#c8161d;color:#fff;border:1px solid #c8161d;border-radius:4px;
        font-size:11px;font-weight:400;cursor:pointer;vertical-align:middle}
      #kfz-result .kfz-ex:hover{background:#a91016;color:#fff;border-color:#a91016}
      /* 点击加入排除名单后的“已排除”状态：灰色、不可再点 */
      #kfz-result .kfz-ex-done{background:#f6f6f6;color:#999;border-color:#e2e2e2;cursor:default}
      #kfz-result .kfz-ex-done:hover{background:#f6f6f6;color:#999;border-color:#e2e2e2}
      /* 底部折叠区：已排除条目 */
      .kfz-exbox{margin:8px 12px 12px;border:1px solid #eee;border-radius:6px;background:#fafafa}
      .kfz-extoggle{padding:6px 8px;font-size:12px;color:#888;cursor:pointer;user-select:none}
      .kfz-extoggle:hover{color:#c8161d}
      .kfz-exlist{padding:0 8px 8px;max-height:180px;overflow:auto}
      .kfz-exrow{display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px dashed #e6e6e6;font-size:12px}
      .kfz-extitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555}
      .kfz-exlist .muted{white-space:nowrap}
      .kfz-restore{flex:0 0 auto;margin:0;padding:1px 6px;background:#fff;color:#c8161d;
        border:1px solid #e6b3b6;border-radius:4px;font-size:11px;cursor:pointer}
      .kfz-restore:hover{background:#c8161d;color:#fff}
      .kfz-exempty{font-size:12px;color:#aaa;padding:4px 0}
      /* v1.2.1: 已排除条目区的批量操作按钮 */
      .kfz-exactions{display:flex;gap:8px;padding:8px 0 2px}
      .kfz-exbtn{flex:1 1 auto;margin:0;padding:5px 8px;background:#fff;color:#666;
        border:1px solid #ddd;border-radius:4px;font-size:12px;cursor:pointer}
      .kfz-exbtn:hover{background:#c8161d;color:#fff;border-color:#c8161d}
      .kfz-exbtn.primary{color:#c8161d;border-color:#e6b3b6}
      .kfz-exbtn.primary:hover{background:#c8161d;color:#fff}
      /* 折叠区：分组标题 / 规则条目 / 规则删除按钮 */
      .kfz-exsec{margin:8px 0 2px;font-size:11px;font-weight:700;color:#666;border-top:1px solid #eee;padding-top:6px}
      .kfz-exsec:first-child{border-top:0;margin-top:0;padding-top:0}
      .kfz-rule{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:#c8161d;background:#fdecec;border:1px solid #f3d3d4;border-radius:3px;padding:0 5px;font-size:11px}
      .kfz-rule-del{flex:0 0 auto;margin:0;padding:1px 6px;background:#fff;color:#999;
        border:1px solid #ddd;border-radius:4px;font-size:11px;cursor:pointer}
      .kfz-rule-del:hover{background:#c8161d;color:#fff;border-color:#c8161d}
      /* 结果区顶部"已排除 N 条"统计条 */
      #kfz-result .kfz-exstat{color:#c8161d;background:#fdf3f3;border:1px solid #f5e0e0;border-radius:4px;
        padding:4px 6px;margin:0 12px 6px}
      /* v1.1.7: 重复购买提示条（浅黄，提示多买了哪些册，非错误） */
      #kfz-result .kfz-dup{color:#8a6d1f;background:#fff8e6;border:1px solid #f0e0b0;border-radius:4px;
        padding:4px 6px;margin:0 12px 6px}
      /* 配置区：标题排除关键词输入框（比分册框矮） */
      #kfz-panel textarea.kfz-exrules{height:56px}
      /* 凑不齐时的错误提示条 */
      #kfz-result .kfz-err{margin:8px 12px 4px;padding:6px 8px;background:#fdecec;border:1px solid #f3d3d4;
        border-radius:6px;color:#c8161d;font-size:12px;font-weight:700}
      /* v1.2.6: 凑不齐时，"缺少分册"用更醒目的红底白字大号 banner */
      #kfz-result .kfz-missing-banner{margin:8px 12px 4px;padding:8px 10px;background:#c8161d;border:2px solid #a91016;
        border-radius:6px;color:#fff;font-size:14px;font-weight:700;line-height:1.6}
      #kfz-result .kfz-missing-banner b{color:#ffe96b;font-weight:700}
      /* v1.2.6: 凑不齐但已找到部分覆盖时，"已凑到 X/Y 册"绿底提示 */
      #kfz-result .kfz-partial-head{margin:8px 12px 4px;padding:6px 8px;background:#ecf7ec;border:1px solid #c9e2c9;
        border-radius:6px;color:#2a7a2a;font-size:14px;font-weight:700}
    `);

    const panel = ce('div', { id: 'kfz-panel' });
    const savedSet = GM_getValue('kfz_set', '');
    const savedVol = GM_getValue('kfz_vol', '');
    const savedCount = GM_getValue('kfz_count', '8');
    // 标题排除关键词按书名隔离：初始载入“上次这套书”的规则
    const savedExRules = loadExRules(String(savedSet || '').trim()).join('\n');

    panel.innerHTML = `
      <div id="kfz-head"><span class="long">📚 孔网合集跨店凑单 v${SCRIPT_VERSION}</span><span class="compact-tag">📚 跨店凑单</span><span style="display:flex;align-items:center"><span class="x" id="kfz-fill" title="把孔夫子搜索栏已提交的关键字填入『整套书名』栏">⬇ 填字</span><span class="x" id="kfz-close">展开 ▴</span></span></div>
      <div id="kfz-result-wrap"><div id="kfz-result"></div></div>
      <div id="kfz-body" style="display:none">
        <label>整套书名 / 系列名</label>
        <input id="kfz-set" value="${escapeAttr(savedSet)}" placeholder="如：明朝那些事儿" />
        <label>出版社 / 年份筛选（选填）</label>
        <input id="kfz-cond" placeholder="如：长安出版社&amp;1999　支持 &amp; 且 | 或" />
        <div class="kfz-tip">选填。填出版社或出版年份可缩小比价范围。用 <b>&amp;</b> 表示“且”（各项都满足才入选），<b>|</b> 表示“或”（任一项满足即入选）。例：<b>长安出版社&amp;1999</b> 表示出版社含“长安出版社”且年份含“1999”的才参与比价；<b>1999|2000</b> 表示年份为 1999 或 2000 均可。</div>
        <div class="row">
          <div>
            <label>册数</label>
            <input id="kfz-count" value="${escapeAttr(savedCount)}" />
            <div class="kfz-tip">最好不要超过 15，会很慢。</div>
          </div>
          <div>
            <label>&nbsp;</label>
            <button class="sec" id="kfz-gen">按“书名+数字”生成</button>
          </div>
        </div>
        <label>各分册搜索词（每行一个，可手动修改）</label>
        <textarea id="kfz-vol" placeholder="文化服装讲座1&#10;文化服装讲座2&#10;文化服装讲座3&#10;...">${escapeHtml(savedVol)}</textarea>
        <div class="kfz-tip">已开启“严格紧贴匹配”：书名必须连续含“文化服装讲座”，自动剔除“文化服装<b>函授</b>讲座”等插入版。按<b>标题实际列出的卷号</b>判定覆盖（支持「讲座2、8」「讲座 2 3 4 5 6 7 8」「讲座1234」「1-8差第4册」等），杜绝“合售”二字就当成全套；常比单本逐册买更便宜。</div>
        <label>标题排除关键词（每行一个，仅对当前书名生效）</label>
        <textarea id="kfz-exrules" class="kfz-exrules" placeholder="1-7大结局&#10;全套包邮">${escapeHtml(savedExRules)}</textarea>
        <div class="kfz-tip">标题里<b>原样连续包含</b>这些字符串的商品，一律不参与比价（用于批量排除“店主把标题写错”的商品）。换一套书会自动切换成那本书的规则。</div>
        <div class="row">
          <button id="kfz-run">🚀 开始智能凑单</button>
          <button class="warn" id="kfz-stop" style="display:none">⏹ 终止计算</button>
          <button class="sec" id="kfz-demo">演示</button>
        </div>
        <div id="kfz-log"></div>
      </div>`;
    document.body.appendChild(panel);

    const log = $('#kfz-log', panel);
    const result = $('#kfz-result', panel);
    const setInput = $('#kfz-set', panel);
    const countInput = $('#kfz-count', panel);
    const volInput = $('#kfz-vol', panel);
    const exRulesInput = $('#kfz-exrules', panel);
    const condInput = $('#kfz-cond', panel);   // v1.2.2: 出版社/年份筛选条件输入框

    const logf = (msg) => { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; };
    const resetOut = () => { result.innerHTML = ''; log.textContent = ''; };

    // ===== 标题排除关键词 / 出版社年份条件：书名变化即恢复默认说明状态 =====
    // “整套书名”框内容一旦改变，就把“出版社/年份筛选”和“标题排除关键词”两个条件框
    // 同时清空回初始占位说明（placeholder 灰字），避免旧书的条件/排除词误套到新书。
    const resetAuxInputs = () => {
      condInput.value = '';        // 出版社/年份筛选 → 恢复说明占位
      exRulesInput.value = '';     // 标题排除关键词 → 恢复说明占位
    };
    const persistExRules = () => {
      saveExRules(setInput.value.trim(), parseExRules(exRulesInput.value));
    };
    // 改完规则立刻用上次结果本地重算（不重新联网检索），即时看到新方案
    const applyExRules = async () => {
      persistExRules();
      const d = STATE.lastData;
      if (d && d.volumes && result.innerHTML) {
        await runWith({ volumes: d.volumes, listings: d.listings }, logf, result, false, condInput ? condInput.value : '');
        logf('🔁 已按新的排除关键词重新计算');
      }
    };
    setInput.addEventListener('input', resetAuxInputs);
    setInput.addEventListener('change', resetAuxInputs);
    exRulesInput.addEventListener('change', applyExRules); // 改完即存并重算，防止没点搜索就丢

    // 拖拽
    drag(panel, $('#kfz-head', panel));

    // 默认收起：仅显示标题栏（body 已在模板里 display:none），如此一进网站不占大面积
    panel.classList.add('kfz-collapsed');

    $('#kfz-close', panel).onclick = () => {
      const b = $('#kfz-body', panel);
      const r = $('#kfz-result-wrap', panel);
      const hidden = b.style.display === 'none';
      b.style.display = hidden ? 'block' : 'none';
      r.style.display = hidden ? 'block' : 'none';  // v1.4.3: 收起时连同结果区一起折进去，只剩标题栏
      $('#kfz-close', panel).textContent = hidden ? '收起 ▾' : '展开 ▴';
      panel.classList.toggle('kfz-collapsed', !hidden); // 收起时加圆角，展开时去掉
    };

    // ===== 与孔夫子网站搜索框联动（自动跟随 + 手动填字） =====
    // 常见搜索框选择器（按特异性从高到低），用于定位孔夫子页面的搜索输入框
    const SITE_SEARCH_SELS = ['#keyword', 'input[name=keyword]', '#searchInput', 'input[type=search]',
      '.search-input', '.searchBox input', '#key', '.header-search input', 'form[action*="search"] input[type=text]'];
    const findSiteSearchInput = () => {
      for (const s of SITE_SEARCH_SELS) { const el = document.querySelector(s); if (el) return el; }
      return null;
    };
    // 取“网站搜索关键字”：优先 URL 的 keyword 参数，其次直接读页面搜索框当前值
    const getSiteKeyword = () => {
      const m = (location.search || '').match(/[?&]keyword=([^&]+)/);
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
      const el = findSiteSearchInput();
      return (el && el.value && el.value.trim()) ? el.value.trim() : '';
    };
    // 手动/事件触发：把网站搜索栏已提交的关键字填入脚本“整套书名”栏
    const fillSetFromSite = () => {
      const kw = getSiteKeyword();
      if (!kw) { logf('⚠ 未检测到孔夫子搜索关键字（请先在网站搜索框输入并搜索）'); return; }
      setInput.value = kw;
      GM_setValue('kfz_set', kw);
      resetAuxInputs(); // 书名变了 → 两个条件框恢复默认说明状态
      logf('⬇ 已从孔夫子搜索栏填入『整套书名』：' + kw);
    };
    // 自动跟随：URL 的 keyword 变化时自动同步（整页跳转后 init 会触发一次）；用户正手动在脚本栏输入时不打断
    let _lastUrlKw = null;
    const syncFromUrl = () => {
      const m = (location.search || '').match(/[?&]keyword=([^&]+)/);
      const kw = m ? (() => { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } })() : '';
      if (kw && kw !== _lastUrlKw) {
        _lastUrlKw = kw;
        if (document.activeElement === setInput) return; // 用户正在脚本里手填，别覆盖
        setInput.value = kw; GM_setValue('kfz_set', kw);
        resetAuxInputs(); // 书名变了 → 两个条件框恢复默认说明状态
        logf('🔄 已自动跟随网站搜索关键字：' + kw);
      } else if (!kw) { _lastUrlKw = null; }
    };
    // 拦截 SPA 式搜索（不整页刷新）：history 变化 / 前进后退 / 哈希变化都触发同步
    const _wrapHist = (type) => { const orig = history[type]; return function () { const r = orig.apply(this, arguments); syncFromUrl(); return r; }; };
    history.pushState = _wrapHist('pushState');
    history.replaceState = _wrapHist('replaceState');
    window.addEventListener('popstate', syncFromUrl);
    window.addEventListener('hashchange', syncFromUrl);
    setInterval(syncFromUrl, 1500); // 兜底轮询，覆盖各种意外情况
    // 监听网站搜索框的提交（回车 / 搜索按钮），立即同步一次
    const bindSiteSearch = () => {
      const el = findSiteSearchInput();
      if (el && !el._kfzBound) {
        el._kfzBound = true;
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTimeout(fillSetFromSite, 0); });
        const form = el.closest('form');
        if (form) form.addEventListener('submit', () => setTimeout(fillSetFromSite, 0));
      }
    };
    bindSiteSearch();
    setTimeout(bindSiteSearch, 1500); // 搜索框可能晚于脚本加载

    // 标题栏“⬇ 填字”小按钮：手动把网站搜索栏已提交的关键字填入脚本栏
    const fillBtn = $('#kfz-fill', panel);
    fillBtn.onmousedown = (e) => e.stopPropagation(); // 避免触发面板拖拽
    fillBtn.onclick = (e) => { e.stopPropagation(); fillSetFromSite(); };

    syncFromUrl(); // 初始进入搜索结果页即自动填一次

    $('#kfz-gen', panel).onclick = () => {
      const name = setInput.value.trim();
      const cnt = parseInt(countInput.value, 10) || 8;
      if (!name) { logf('请先填写整套书名'); return; }
      const lines = [];
      for (let i = 1; i <= cnt; i++) lines.push(name + i); // 直接拼接数字：文化服装讲座1 … 文化服装讲座8
      volInput.value = lines.join('\n');
    };

    const stopBtn = $('#kfz-stop', panel);
    // v1.3.1: 终止计算按钮——单向置位 aborted，所有热循环检查到即抛出，最迟 ~1ms 内响应
    stopBtn.onclick = () => {
      if (STATE.aborted) return;          // v1.3.2: 已按下则忽略重复点击
      STATE.aborted = true;
      stopBtn.classList.add('stopping');  // v1.3.2: 橙色高亮 + 文字变“终止中…”，告知用户已生效
      stopBtn.textContent = '终止中…';
      logf('⏹ 正在终止计算…（稍候）');
    };

    $('#kfz-demo', panel).onclick = () => {
      resetOut();
      STATE.aborted = false;
      const btn = $('#kfz-run', panel); btn.disabled = true; btn.textContent = '演示中…';
      stopBtn.classList.remove('stopping'); stopBtn.textContent = '⏹ 终止计算'; stopBtn.style.display = '';
      const finish = () => { btn.disabled = false; btn.textContent = '🚀 开始智能凑单'; stopBtn.classList.remove('stopping'); stopBtn.textContent = '⏹ 终止计算'; stopBtn.style.display = 'none'; };
      runWith(gatherMock(), logf, result, true, condInput ? condInput.value : '')
        .catch((e) => { if (!/用户终止了计算|aborted/i.test(e && e.message)) logf('出错：' + e.message); else logf('⏹ 已终止计算。'); })
        .finally(finish);
    };

    $('#kfz-run', panel).onclick = async () => {
      resetOut();
      const lines = volInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) { logf('请先填写分册（至少 1 行）'); return; }
      // v1.1.6: 册数过多拒绝（JS 位运算 32 位限制：1 << n 在 n>30 时被截断为 mod 32，会让"凑齐"误判）
      if (lines.length > 30) {
        logf('❌ 册数过多（' + lines.length + ' 册）。优化算法使用位掩码（1 << n），JS 在 n>30 时会按 mod 32 截断，导致"凑齐"误判。请拆成 ≤30 册的小套搜索（如 "1-10" "11-20" "21-30" 分别搜）。');
        result.innerHTML = '<div class="kfz-err">❌ 册数过多（' + lines.length + ' 册）。请拆成 ≤30 册的小套分别搜索。</div>';
        return;
      }
      GM_setValue('kfz_set', setInput.value);
      GM_setValue('kfz_count', countInput.value);
      GM_setValue('kfz_vol', volInput.value);
      GM_setValue('kfz_cond', condInput.value);   // v1.2.2: 持久化出版社/年份筛选条件
      persistExRules();                   // 保存这套书的标题排除关键词
      STATE.base = setInput.value.trim(); // 用于严格紧贴匹配
      STATE.aborted = false;              // v1.3.1: 新一轮运行清除上轮中止标志
      const volumes = lines.map((kw, i) => ({ name: '第' + (i + 1) + '册', keyword: kw }));
      const btn = $('#kfz-run', panel); btn.disabled = true; btn.textContent = '检索中…';
      stopBtn.classList.remove('stopping'); stopBtn.textContent = '⏹ 终止计算'; stopBtn.style.display = '';  // v1.3.2: 显示并复位为高亮前的“终止计算”态
      try {
        logf('开始跨店检索，共 ' + volumes.length + ' 册…');
        const { listings, perVolumeCount } = await gatherListings(volumes,
          (i, n, name, cnt) => { logf('(' + (i + 1) + '/' + n + ') 检索：' + name + ' → 找到 ' + cnt + ' 条'); },
          logf);
        logf('检索完成，候选条目 ' + listings.length + ' 条，开始计算最优组合…');
        await runWith({ volumes, listings }, logf, result, false, condInput ? condInput.value : '');
      } catch (e) {
        if (/用户终止了计算|aborted/i.test(e && e.message)) {
          logf('⏹ 已终止计算。');
        } else {
          logf('出错：' + e.message);
        }
      } finally {
        btn.disabled = false; btn.textContent = '🚀 开始智能凑单';
        stopBtn.classList.remove('stopping'); stopBtn.textContent = '⏹ 终止计算'; stopBtn.style.display = 'none';   // v1.3.2: 复位并隐藏终止按钮
      }
    };

    // 若当前页面是商品/搜索页，尝试用标题预填书名（去掉网站名等无关片段）
    try {
      const parts = (document.title || '').split(/[-_|·]/).map((s) => s.trim());
      const guess = parts.find((p) => p && !/孔夫子|kongfz|旧书网|搜索|book/i.test(p)) || parts[0] || '';
      if (guess && !setInput.value) setInput.value = guess;
    } catch (e) {}
  }

  let _planGen = 0;  // v1.4.2: 方案计算代次，防止重入时旧的后台计算误写新的 DOM

  async function runWith(data, logf, result, isDemo, condStrIn) {
    const { volumes, listings } = data;
    // v1.2.6: 抽 renderPlanSection，成功与“凑不齐有部分覆盖”两种场景共用方案表格渲染
    function renderPlanSection(plan, total, volumes, effective, isPartial, isDemo) {
      const naive = naivePlan(volumes, effective);
      const saved = naive - total;
      // ★ v1.1.7：统计“重复购买”的册（算法用 OR 合并 volMask，允许重叠覆盖——多买也可以，只要总价最便宜）
      const volCount = new Map();
      plan.forEach((p) => {
        p.listings.forEach((L) => {
          let m = L.volMask;
          while (m) { const low = m & -m; const idx = Math.round(Math.log2(low)); volCount.set(idx, (volCount.get(idx) || 0) + 1); m &= m - 1; }
        });
      });
      const dupIdx = [...volCount.entries()].filter(([, c]) => c > 1).map(([i]) => i).sort((a, b) => a - b);
      const n = volumes.length;
      let coveredCount = n;
      if (isPartial) {
        const partialMask = plan.reduce((a, p) => a | p.listings.reduce((b, L) => b | L.volMask, 0), 0);
        coveredCount = 0; { let mm = partialMask; while (mm) { coveredCount++; mm &= mm - 1; } }
      }
      let html = '';
      if (isPartial) {
        html += '<div class="kfz-partial-head">✅ 已凑到 <b>' + coveredCount + '/' + n + ' 册</b>：最低 ' + yuan(total) + '（共 ' + plan.length + ' 家店）</div>';
      } else {
        html += '<div class="total">💰 最低总价：' + yuan(total) + '（共 ' + plan.length + ' 家店）</div>';
      }
      if (dupIdx.length) {
        const names = dupIdx.map((i) => (volumes[i] ? volumes[i].name : '第' + (i + 1) + '册')).join('、');
        html += '<div class="kfz-tip kfz-dup">📦 本方案<b>重复购买</b>了 ' + names +
          '（多家店都含这几册）。多买也算，只要总价最便宜——不想重复可用「🚫排除」去掉某家店。</div>';
      }
      html += '<div class="kfz-tip">对比：各册分别买最便宜的（含各自运费）约 ' + yuan(naive) +
        '，本方案可省 ' + yuan(Math.max(0, saved)) + (isPartial ? '（按已凑到的册比较）' : '') + '</div>';
      html += '<table><thead><tr><th>店铺</th><th>册数与单册价</th><th>运费</th><th>小计</th></tr></thead><tbody>';
      plan.forEach((p) => {
        const items = p.listings.map((L) => {
          const vols = maskToNames(L.volMask, volumes);
          const k = exKeyOf(L);
          const exclBtn = k
            ? '<button class="kfz-ex" data-key="' + escapeAttr(k) + '" data-title="' + escapeAttr(shortTitle(L.title, 30)) +
              '" data-shop="' + escapeAttr(L.shopName || '') + '" data-link="' + escapeAttr(L.link || '') +
              '" data-price="' + (L.price || 0) + '" title="把这条商品加入排除名单，下次检索不再计入">🚫排除</button>'
            : '';
          return '<div class="kfz-itemrow">《' + escapeHtml(shortTitle(L.title, 22)) + '》<span class="muted">' + vols + '</span> ' +
            yuan(L.price) + exclBtn + '</div>';
        }).join('');
        html += '<tr>' +
          '<td class="shop"><a href="' + escapeAttr(p.shop.shopLink) + '" target="_blank" style="color:#c8161d">' + escapeHtml(p.shop.shopName) + '</a></td>' +
          '<td>' + items + '</td>' +
          '<td>' + (p.shipping > 0 ? yuan(p.shipping) : '包邮') + '</td>' +
          '<td>' + yuan(p.subtotal) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      html += '<div class="kfz-tip">点击店名可进店核对；下单前请确认品相与库存。点“🚫排除”可让该条下次检索不再计入。' + (isDemo ? '（演示数据）' : '') + '</div>';
      return html;
    }

    // v1.1.6: 防御性 n>30 保护（JS 位运算 mod 32 截断）。正常流程在 kfz-run 已拦，这里兜底 demo/手工调用。
    if (volumes.length > 30) {
      const msg = '❌ 册数过多（' + volumes.length + ' 册），超出位掩码算法上限（30）。请拆成小套搜索。';
      logf(msg);
      result.innerHTML = '<div class="kfz-err">❌ 册数过多（' + volumes.length + ' 册）。请拆成 ≤30 册的小套分别搜索。</div>';
      return;
    }
    // ---- 算价前统一过滤：① 标题排除关键词（按当前书名）② 手动排除名单 ③ 出版社/年份筛选条件 ----
    // 放在算价阶段而非检索阶段，是为了让"加/删规则/改条件"能立刻本地重算，无需重新联网检索。
    const book = STATE.base || (volumes[0] && volumes[0].keyword) || '';
    const exRules = isDemo ? [] : loadExRules(book);
    const exMap = isDemo ? {} : (loadExcluded() || {});
    const condStr = (typeof condStrIn === 'string' ? condStrIn : '').trim();     // v1.2.2: 出版社/年份筛选条件（来自调用方，跨作用域）
    const condPred = parseCondition(condStr);
    const hitRules = [];      // 命中标题排除关键词的条目
    const hitManual = [];     // 命中手动排除名单的条目
    const hitCond = [];       // 命中出版社/年份筛选条件（被条件过滤掉）的条目
    const effective = (listings || []).filter((L) => {
      const r = matchExRules(L.title, exRules);
      if (r) { hitRules.push({ L, rule: r }); return false; }
      if (exMap['id:' + L.itemId] || (L.link && exMap['lk:' + L.link])) { hitManual.push(L); return false; }
      if (condPred && !condPred(L)) { hitCond.push(L); return false; }
      return true;
    });
    if (condPred && hitCond.length) logf('🔍 按出版社/年份条件「' + condStr + '」过滤掉 ' + hitCond.length + ' 条（不计入比价）');
    STATE.lastFilterInfo = { book, exRules, hitRules, hitManual, hitCond, condStr, total: (listings || []).length };
    if (!isDemo) STATE.lastData = { volumes, listings }; // 供“改规则后本地重算”使用（原始未过滤集合）

    // v1.4.1: 计算前 3 个“强制错开店铺”方案——
    //   第1方案 = 最便宜组合；第2方案 = 避开第1用过的店后最便宜；第3方案 = 避开前两用过的店后最便宜。
    //   部分覆盖场景同样适用（木木确认：凑不齐时也列第2/3备选）。
    const shopIdsOf = (r) => {
      if (!r) return [];
      const arr = r.ok ? r.plan : (r.partialPlan || []);
      return arr.map((p) => (p.shop && p.shop.shopId)).filter(Boolean);
    };
    // v1.4.2: 先算第1方案并立即渲染，第2/第3方案在后台接着算，不阻塞第1方案的显示
    const labels = ['第一方案', '第二方案', '第三方案'];
    const views = [null, null, null];   // 预分配，第1立即填，第2/3后台算完再填
    const plans = [];
    let leftover = effective;
    const usedShopIds = new Set();

    // 把 optimize 结果规范成可渲染视图（ok=完整覆盖；否则取部分覆盖；都没有=无方案）
    const viewOf = (r) => {
      if (!r) return null;
      if (r.ok) return { isPartial: false, total: r.total, plan: r.plan, missing: null };
      if (r.partialPlan && r.partialPlan.length) return { isPartial: true, total: r.partialTotal, plan: r.partialPlan, missing: r.missing };
      return null;
    };

    // —— 1) 先算第1方案 ——
    logf('🧮 计算第1方案…');
    const r0 = await optimize(volumes, leftover, {});
    plans[0] = r0;
    const s0 = shopIdsOf(r0);
    if (s0.length) s0.forEach((id) => usedShopIds.add(id));
    views[0] = viewOf(r0);

    // 一个方案都没有（极罕见：过滤后无可用条目）→ 简版错误提示
    if (!views[0]) {
      let msg = '❌ ' + ((r0 && r0.error) || '无法凑齐');
      if (r0 && r0.missing && r0.missing.length) {
        msg += '。缺少分册：' + r0.missing.map((i) => volumes[i].name + '（' + volumes[i].keyword + '）').join('、');
      }
      msg += '。可尝试：放宽品相/包邮筛选、调大“每册搜索页数”、或减少“标题排除关键词”/恢复已排除条目。';
      result.innerHTML = '<div class="kfz-err">' + escapeHtml(msg).replace(/\n/g, '<br>') +
        '</div>' + renderExcludeBox(book, exRules, hitRules, hitManual);
      bindExcludeEvents(result, logf, { volumes, listings });
      logf(msg);
      return;
    }

    // 顶部“无法凑齐整套”红底 banner：仅在第1方案本身即部分覆盖时提示缺哪几册
    let eh = '';
    if (!r0.ok && r0.missing && r0.missing.length) {
      const blocked = hitRules.length + hitManual.length;
      eh += '<div class="kfz-missing-banner">❌ 无法凑齐整套<br>缺少分册：<b>' +
        r0.missing.map((i) => volumes[i].name).join('、') + '</b>';
      if (blocked || hitCond.length) {
        eh += '<br><span style="font-size:11px;font-weight:400">';
        if (blocked) eh += '（当前因排除少算 ' + blocked + ' 条，可在下方折叠区减少规则或恢复条目）';
        if (hitCond.length) eh += (blocked ? '；' : '（') + '因出版社/年份条件少算 ' + hitCond.length + ' 条' + (blocked ? '' : '）');
        eh += '</span>';
      }
      eh += '</div>';
    }

    // v1.4.2: 方案切换条。第1默认高亮；第2/3初始显示“计算中…”并禁用，后台算完再点亮
    eh += '<div class="kfz-plan-switch" id="kfz-plan-switch"><span class="kfz-ps-label">方案：</span>';
    eh += '<button class="ps active" data-i="0">第一方案</button>';
    eh += '<button class="ps loading" data-i="1" disabled>第二方案（计算中…）</button>';
    eh += '<button class="ps loading" data-i="2" disabled>第三方案（计算中…）</button>';
    eh += '</div><div id="kfz-plan-body"></div>';

    // —— 排除统计提示 ——
    if (hitRules.length || hitManual.length) {
      const bits = [];
      if (hitRules.length) bits.push('关键词命中 ' + hitRules.length + ' 条');
      if (hitManual.length) bits.push('手动排除 ' + hitManual.length + ' 条');
      eh += '<div class="kfz-tip kfz-exstat">🚫 已排除 ' + (hitRules.length + hitManual.length) + ' 条不参与比价（' +
        bits.join('、') + '），展开最下方折叠区可管理。</div>';
    }

    eh += renderExcludeBox(book, exRules, hitRules, hitManual);
    result.innerHTML = eh;
    // 传回“未被过滤的原始 listings”，保证 rerun 幂等（由 runWith 自己重新过滤，不会越过滤越少）
    bindExcludeEvents(result, logf, { volumes, listings });

    const switchEl = document.getElementById('kfz-plan-switch');

    // v1.4.2: 渲染某个方案的正文（默认第1，按钮切换第2/3）。views[i] 为空时（未算完/无方案）不渲染
    const renderBody = (idx) => {
      const v = views[idx];
      const body = document.getElementById('kfz-plan-body');
      if (!body || !v) return;
      body.innerHTML = renderPlanSection(v.plan, v.total, volumes, effective, v.isPartial, isDemo);
      document.querySelectorAll('#kfz-plan-switch .ps').forEach((b) => {
        b.classList.toggle('active', (+b.dataset.i) === idx);
      });
      const wp = document.getElementById('kfz-result-wrap'); if (wp) wp.scrollTop = 0;
      const pn = document.getElementById('kfz-panel'); if (pn) pn.scrollTop = 0;
    };
    renderBody(0);

    // 切换按钮事件
    document.querySelectorAll('#kfz-plan-switch .ps').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        const i = +b.dataset.i;
        renderBody(i);
        const v = views[i];
        logf('👉 已切换到' + labels[i] + '（' + (v.isPartial ? '已凑到部分覆盖' : '完整凑齐') + '，总价 ' + yuan(v.total) + '）');
      });
    });

    logf((views[0].isPartial ? '✅ 已算出部分覆盖方案，总价 ' : '✅ 已算出最优跨店组合，总价 ') + yuan(views[0].total) +
      '；第2/第3方案正在后台计算…');

    // —— 2) 后台接着算第2、第3方案（不阻塞第1方案的显示）——
    const myGen = ++_planGen;   // 重入保护：若用户重新运行，旧的 computeMore 不再写 DOM
    const computeMore = async () => {
      let lf = leftover.filter((L) => !usedShopIds.has(L.shopId));
      for (let k = 2; k <= 3; k++) {
        if (STATE.aborted || myGen !== _planGen) return;
        if (!lf.length) break;
        logf('🧮 计算第' + k + '方案…（已避开前 ' + (k - 1) + ' 个方案用过的店铺）');
        const r = await optimize(volumes, lf, {});
        if (myGen !== _planGen) return;
        plans[k - 1] = r;
        const sids = shopIdsOf(r);
        const v = viewOf(r);
        views[k - 1] = v;
        const btn = switchEl ? switchEl.querySelector('[data-i="' + (k - 1) + '"]') : null;
        if (btn) {
          btn.classList.remove('loading');
          if (v) {
            btn.disabled = false;
            btn.textContent = labels[k - 1];
          } else {
            btn.disabled = true;
            btn.textContent = labels[k - 1] + '（无）';
          }
        }
        if (!sids.length) break;
        sids.forEach((id) => usedShopIds.add(id));
        lf = lf.filter((L) => !usedShopIds.has(L.shopId));
        if (!lf.length) break;
      }
      if (myGen !== _planGen) return;
      const avail = [];
      for (let i = 1; i < 3; i++) if (views[i]) avail.push(labels[i]);
      if (avail.length) logf('✅ 第2/第3方案计算完成，可点『' + avail.join('、') + '』看避开同店的备选组合');
    };
    void computeMore();
  }

  // 渲染结果区底部的“排除管理”折叠区（规则 + 已排除条目）
  // 成功与失败两种情况下都会渲染，保证用户随时能删规则/恢复条目救回来。
  function renderExcludeBox(book, exRules, hitRules, hitManual) {
    const exList = listExcluded();
    const ruleCount = (exRules || []).length;
    const totalBlocked = (hitRules || []).length + (hitManual || []).length;
    let h = '<div id="kfz-exbox" class="kfz-exbox">';
    h += '<div id="kfz-extoggle" class="kfz-extoggle">🚫 排除管理：规则 ' + ruleCount + ' 条 / 条目 ' + exList.length +
      ' 条' + (totalBlocked ? ' / 本次命中 ' + totalBlocked + ' 条' : '') + ' ▸ 点击展开</div>';
    h += '<div id="kfz-exlist" class="kfz-exlist" style="display:none">';

    // ① 标题排除关键词（仅对当前书名生效）
    h += '<div class="kfz-exsec">标题排除关键词' +
      '<span class="muted">（仅对《' + escapeHtml(shortTitle(book, 14)) + '》生效）</span></div>';
    if (!ruleCount) {
      h += '<div class="kfz-exempty">暂无规则。可在下方配置区“标题排除关键词”里添加（每行一个）。</div>';
    } else {
      (exRules || []).forEach((r) => {
        const n = (hitRules || []).filter((x) => x.rule === r).length;
        h += '<div class="kfz-exrow">' +
          '<span class="kfz-rule" title="标题包含此串即排除">' + escapeHtml(r) + '</span>' +
          '<span class="muted">' + n + ' 条命中</span>' +
          '<button class="kfz-rule-del" data-rule="' + escapeAttr(r) + '" title="删除这条规则并立即重算">✕</button>' +
          '</div>';
      });
    }

    // ② 手动排除的条目
    h += '<div class="kfz-exsec">已排除条目</div>';
    if (!exList.length) {
      h += '<div class="kfz-exempty">暂无被排除的条目。</div>';
    } else {
      exList.sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach((e) => {
        h += '<div class="kfz-exrow">' +
          '<span class="kfz-extitle" title="' + escapeAttr(e.title) + '">《' + escapeHtml(shortTitle(e.title, 20)) + '》</span>' +
          '<span class="muted">' + escapeHtml(e.shopName || '') + ' ' + yuan(e.price || 0) + '</span>' +
          '<button class="kfz-restore" data-key="' + escapeAttr(e.key) + '" title="恢复这条商品，下次检索重新计入">↩ 恢复</button>' +
          '</div>';
      });
    }
    // ③ 批量操作：解除相关书名排除 / 一键清空列表
    h += '<div class="kfz-exactions">' +
      '<button class="kfz-exbtn primary" data-act="rel" title="释放本页“已排除条目”里标题含当前书名、以及当前书名的标题排除关键词规则的条目，让它们下次重新进运算">🔓 解除相关书名排除</button>' +
      '<button class="kfz-exbtn" data-act="clear" title="清空整个已排除条目名单（所有书），下次检索全部重新计入">🧹 一键清空列表</button>' +
      '</div>';
    h += '</div></div>';
    return h;
  }

  // 绑定“排除 / 恢复 / 规则删除”按钮事件；操作后立即重算并刷新结果
  // data 为 {volumes, listings}，其中 listings 必须是未经排除过滤的原始集合（保证重算幂等）
  function bindExcludeEvents(result, logf, data) {
    if (!result) return;
    // 直接把原始集合交回 runWith，由其内部统一过滤（规则 + 手动名单），不在这里预筛
    const rerun = () => {
      if (!data || !data.volumes) return;
      runWith({ volumes: data.volumes, listings: data.listings || [] }, logf, result, false, condInput ? condInput.value : '');   // fire-and-forget（runWith 内部 await optimize，但这里只需触发；UI 由 runWith 自身 innerHTML 更新）
    };

    // 删除一条“标题排除关键词”规则（当前书名下），同步输入框后重算
    result.querySelectorAll('.kfz-rule-del').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const rule = btn.getAttribute('data-rule');
        if (!rule) return;
        const book = (STATE.lastFilterInfo && STATE.lastFilterInfo.book) || STATE.base || '';
        const rules = loadExRules(book).filter((r) => r !== rule);
        saveExRules(book, rules);
        const box = document.getElementById('kfz-exrules');
        if (box) box.value = rules.join('\n');   // 同步配置区输入框，避免两处不一致
        logf('✕ 已删除排除规则「' + rule + '」并重新计算');
        rerun();
      };
    });

    result.querySelectorAll('.kfz-ex').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const key = btn.getAttribute('data-key');
        const title = btn.getAttribute('data-title') || '';
        if (!key) return;
        if (btn.classList.contains('kfz-ex-done')) return;   // 已排除过，避免重复
        addExcluded({
          itemId: key.indexOf('id:') === 0 ? key.slice(3) : null,
          link: btn.getAttribute('data-link') || '',
          title, shopName: btn.getAttribute('data-shop') || '',
          price: Number(btn.getAttribute('data-price')) || 0,
        });
        logf('🚫 已排除：《' + title + '》下次检索将跳过（可在最下方折叠区恢复）');
        // v1.2.4: 点“🚫排除”后按钮先转为灰色“✓已排除”（视觉确认），稍后重算；
        // 重算时该条已被过滤，整行会消失，所以这里给 700ms 让灰色状态可见。
        btn.classList.add('kfz-ex-done');
        btn.disabled = true;
        btn.textContent = '✓已排除';
        setTimeout(rerun, 700);
      };
    });

    result.querySelectorAll('.kfz-restore').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const key = btn.getAttribute('data-key');
        if (!key) return;
        if (removeExcluded(key)) logf('↩ 已恢复该条目，下次检索重新计入');
        rerun();
      };
    });

    // ③ 批量操作按钮：解除相关书名排除 / 一键清空列表
    const relBtn = result.querySelector('[data-act="rel"]');
    if (relBtn) relBtn.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const bk = (STATE.lastFilterInfo && STATE.lastFilterInfo.book) || STATE.base || '';
      if (!bk) { logf('⚠ 尚未确定“整套书名”，无法判断相关性，已跳过'); return; }
      const rel = releaseRelatedExcluded(bk);
      // 同时清空当前书名下的标题排除关键词规则（按书名隔离），让关键词排除的商品也重新进运算
      let relRules = 0;
      const rules = loadExRules(bk);
      if (rules.length) {
        relRules = rules.length;
        saveExRules(bk, []);
        const box = document.getElementById('kfz-exrules');
        if (box) box.value = '';   // 同步配置区输入框，避免两处不一致
      }
      logf('🔓 已解除《' + bk + '》相关 ' + rel + ' 条手动排除' + (relRules ? ' + ' + relRules + ' 条关键词规则' : '') + '，并重新计算');
      rerun();
    };
    const clrBtn = result.querySelector('[data-act="clear"]');
    if (clrBtn) clrBtn.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const cnt = clearAllExcluded();
      logf('🧹 已清空全部 ' + cnt + ' 条已排除条目，并重新计算');
      rerun();
    };

    const tg = result.querySelector('#kfz-extoggle');
    const list = result.querySelector('#kfz-exlist');
    if (tg && list) {
      tg.onclick = () => {
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'block';
        const n = listExcluded().length;
        tg.textContent = (open ? '🚫 已排除条目（' + n + '）▸ 点击展开' : '🚫 已排除条目（' + n + '）▾ 点击收起');
      };
    }
  }

  // 卷掩码 → 卷名
  function maskToNames(mask, volumes) {
    const names = [];
    let m = mask;
    while (m) {
      const low = m & -m;
      const idx = Math.round(Math.log2(low));
      names.push(volumes[idx] ? volumes[idx].name : ('第' + (idx + 1) + '册'));
      m &= m - 1;
    }
    return names.join('、');
  }
  function shortTitle(t, len) { t = t || ''; return t.length > len ? t.slice(0, len) + '…' : t; }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  // 演示数据：最优解是“跨店组合”（书店A买1/2册包邮 + 书店B买3册包邮 = ¥12），
  // 而“每册都挑最便宜的店铺”会因各自运费变成 ¥27，用来直观展示跨店凑单的价值。
  function gatherMock() {
    const volumes = [
      { name: '第1册', keyword: '测试 第1册' },
      { name: '第2册', keyword: '测试 第2册' },
      { name: '第3册', keyword: '测试 第3册' },
    ];
    const L = (shopId, shopName, title, price, free, volMask, shipping) =>
      ({ itemId: shopId * 100 + volMask, title, price, shopId, shopName, shopLink: 'https://shop.kongfz.com/' + shopId, link: '', qualityText: '九品', free, shipping: free ? 0 : (shipping || 0), volMask });
    const listings = [
      // 三家“超便宜但要运费”的店（朴素方案会各自付运费）
      L(1, '特价店T', '测试 第1册', 1, false, 1, 8),
      L(2, '特价店U', '测试 第2册', 1, false, 2, 8),
      L(3, '特价店V', '测试 第3册', 1, false, 4, 8),
      // 书店A：1、2册包邮；书店B：3册包邮 —— 跨店组合最优
      L(4, '书店A', '测试 第1册', 4, true, 1),
      L(4, '书店A', '测试 第2册', 4, true, 2),
      L(5, '书店B', '测试 第3册', 4, true, 4),
      // 一家“整套打包”店（合售），价格13包邮（次优，用来验证算法会权衡）
      L(6, '套装店C', '测试123 合售1-3册', 13, true, 7),
    ];
    return { volumes, listings };
  }

  // 简单拖拽
  function drag(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function init() {
    if (document.getElementById('kfz-panel')) return;
    buildPanel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
