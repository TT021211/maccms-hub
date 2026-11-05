'use strict';

/**
 * 爱情岛站点适配器（https://vip.aqdm888.com:20844 等镜像，AQDLT_BASE 可换）。
 * 页面是 sojson 混淆（`var html='...'` 反转字符串 + 解码桩 document.write 还原），
 * 解析前先用 vm 还原（只给 document/console 桩，无网络能力，5 秒超时）。
 * 详情页内嵌原生 m3u8（cdn.aqd-tv.com）→ passthrough 直传，无需转封装/中转。
 * 注意：本站暂未发现站内搜索入口，buildSearchUrl 遇到 query 直接抛错，
 * 框架转 502，聚合搜索单源失败自动跳过；频道页不设搜索框。
 */

const cheerio = require('cheerio');
const vm = require('vm');

const CATS = [
  { type_id: 1, type_name: '最新更新', genre: '', sort: '', group: '精選' },
  { type_id: 2, type_name: '中國大陸', genre: '/videos/category/cn.html', sort: '', group: '地區' },
  { type_id: 3, type_name: '歐美', genre: '/videos/category/west.html', sort: '', group: '地區' },
  { type_id: 4, type_name: '日本', genre: '/videos/category/jp.html', sort: '', group: '地區' },
  { type_id: 5, type_name: '韓國', genre: '/videos/category/kr.html', sort: '', group: '地區' },
  { type_id: 6, type_name: '無碼', genre: '/videos/tag/uncensored.html', sort: '', group: '標籤' },
  { type_id: 7, type_name: 'H動畫', genre: '/videos/tag/cartoon.html', sort: '', group: '標籤' },
  { type_id: 8, type_name: '自拍', genre: '/videos/tag/zipai.html', sort: '', group: '標籤' },
  { type_id: 9, type_name: '中文字幕', genre: '/videos/tag/caption.html', sort: '', group: '標籤' },
  { type_id: 10, type_name: '学生', genre: '/videos/tag/student.html', sort: '', group: '標籤' },
  { type_id: 11, type_name: '制服誘惑', genre: '/videos/tag/uniform.html', sort: '', group: '標籤' },
  { type_id: 12, type_name: 'Cosplay', genre: '/videos/tag/cosplay.html', sort: '', group: '標籤' },
  { type_id: 13, type_name: '無套中出', genre: '/videos/tag/injection.html', sort: '', group: '標籤' },
];

const catById = (t) => CATS.find((c) => String(c.type_id) === String(t));

const UA_LIST = [
  process.env.AQDLT_UA || '',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
].filter(Boolean);

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * sojson 还原：在 Node vm 里跑站点自己的解码桩（document.write 劫持取结果）。
 * 非混淆页原样返回；解码失败也原样返回（parse 阶段再尽力而为）。
 */
function deobfuscate(pageHtml) {
  const marker = 'var html = ';
  const start = pageHtml.indexOf(marker);
  if (start === -1) return pageHtml;
  let i = start + marker.length;
  while (i < pageHtml.length && /\s/.test(pageHtml[i])) i++;
  const quote = pageHtml[i];
  if (quote !== "'" && quote !== '"') return pageHtml;
  i++;
  let raw = '';
  while (i < pageHtml.length) {
    const ch = pageHtml[i];
    if (ch === '\\') {
      raw += ch + (pageHtml[i + 1] || '');
      i += 2;
      continue;
    }
    if (ch === quote) break;
    raw += ch;
    i++;
  }
  if (!raw) return pageHtml;
  const varCode = `var html = ${quote}${raw}${quote};`;
  const scripts = [...pageHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const decoder = scripts.filter((s) => /sojson|fromCharCode|reverse/.test(s)).pop();
  if (!decoder) return pageHtml;
  try {
    const noopEl = { parentNode: { removeChild() {} } };
    const sandbox = {
      document: { write: (s) => sandbox.__out.push(String(s)), getElementById: () => noopEl },
      window: {},
      location: {},
      navigator: {},
      console: { log() {} },
      __out: [],
    };
    vm.createContext(sandbox);
    vm.runInContext(`${varCode}\n${decoder}`, sandbox, { timeout: 5000 });
    const out = sandbox.__out.join('');
    // 解码成功：产出与原文不同且含 HTML 标签；否则回退原文
    if (out && out !== pageHtml && /<[a-z][^>]*>/i.test(out)) return out;
  } catch {
    /* 掉回原文 */
  }
  return pageHtml;
}

function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  void sort;
  if (query) throw new Error('aqdlt search not supported');
  let path = genre || '';
  if (!path) {
    if (pg <= 1) return `${base}/`;
    return `${base}/videos/index/${pg}.html`;
  }
  if (pg <= 1) return `${base}${path}`;
  return `${base}${path.replace(/\.html$/, '')}/${pg}.html`;
}

// 详情链接：/videos/play/<数字id>.html；绝对/相对都认
function normVid(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return '';
  let p = '';
  if (href.startsWith('/')) p = href;
  else {
    try {
      const u = new URL(href, base || 'https://vip.aqdm888.com:20844');
      if (!/aqdm\d+\.com|aqdlt|aqdsp/.test(u.hostname)) return '';
      p = u.pathname;
    } catch {
      return '';
    }
    if (!p) return '';
  }
  const m = p.split('#')[0].split('?')[0].match(/^\/videos\/play\/(\d+)\.html$/i);
  return m ? m[1] : '';
}

function pickPic($, anchor) {
  const urls = [];
  anchor.find('img').each((_, img) => {
    // data-src/data-original 优先：真实封面常在懒加载属性里，src 可能是占位图
    for (const a of ['data-src', 'data-original', 'src']) {
      const s = $(img).attr(a) || '';
      if (!s || /icon|avatar|logo/i.test(s)) continue;
      urls.push(s.startsWith('//') ? 'https:' + s : s);
    }
  });
  const cover = urls.find((u) => /thumbs\/|cover|fuqiu/i.test(u));
  if (cover) return cover;
  // 全站通用占位图直接丢掉
  const real = urls.find((u) => !/4135|placeholder|loading|blank|grey/i.test(u));
  return real || '';
}

function parseList(html) {
  const $ = cheerio.load(deobfuscate(html));
  // 同一视频有两个 <a>（缩略图卡 + 标题行），按 vid 合并：标题取最长的，封面取真实的
  // 注意：缩略卡 <a> 的标题在 alt 属性（不是 title），图片 alt 也是全标题
  const byVid = new Map();
  $('a[href]').each((_, a) => {
    const vid = normVid($(a).attr('href') || '', '');
    if (!vid) return;
    const inner = $(a);
    const cands = [
      clean(inner.attr('title') || ''),
      clean(inner.attr('alt') || ''),
      clean(inner.find('img').first().attr('alt') || ''),
      clean(inner.text()).slice(0, 120),
    ].filter(Boolean);
    const title = cands.sort((x, y) => y.length - x.length)[0] || '';
    const pic = pickPic($, inner);
    const cur = byVid.get(vid) || { vid, title: '', pic: '' };
    if (title.length > cur.title.length) cur.title = title;
    if (pic && (!cur.pic || !/thumbs\/|cover|fuqiu/i.test(cur.pic))) cur.pic = pic;
    byVid.set(vid, cur);
  });
  return [...byVid.values()].filter((v) => v.title);
}

function parsePageCount(html, pg) {
  const text = deobfuscate(html);
  let max = pg;
  const m = text.match(/共\s*(\d+)\s*页/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = Math.min(n, 500);
  }
  const pats = [/\/videos\/index\/(\d+)\.html/g, /[?&]page=(\d+)/g];
  for (const re of pats) {
    let mm;
    while ((mm = re.exec(text))) {
      const n = parseInt(mm[1], 10);
      if (!isNaN(n) && n > max && n < 10000) max = n;
    }
  }
  return max;
}

const SURRIT_RE = /https?:\/\/[^\s"'<>]*surrit[^\s"'<>]*?\.m3u8[^\s"'<>]*/i;
const ANY_M3U8_RE = /https?:\/\/[^\s"'<>]*?\.m3u8[^\s"'<>]*/i;

function parseDetail(html, vid) {
  const $ = cheerio.load(deobfuscate(html));
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean($('h1').first().text()).slice(0, 120);
  if (!title) title = clean(og('title').replace(/\s*[-–|]\s*爱情岛.*$/i, ''));
  if (!title) title = `aqdlt ${vid}`;
  const picRaw = og('image') || '';
  const desc = clean(og('description'));

  let actor = '';
  const tagLinks = [];
  let genreName = '';
  $('a[href*="/videos/category/"], a[href*="/videos/tag/"]').each((_, a) => {
    const t = clean($(a).text());
    if (!t || t.length > 20 || tagLinks.includes(t)) return;
    tagLinks.push(t);
    if (!genreName && /\/videos\/category\//.test($(a).attr('href') || '')) genreName = t;
  });

  const text = $.html();
  const lit = text.match(SURRIT_RE) || text.match(ANY_M3U8_RE);
  const m3u8 = lit ? lit[0].replace(/[\\,;)\]]+$/, '') : '';
  const sources = m3u8 ? [{ size: 0, src: m3u8 }] : [];
  const episodes = [{ name: '正片', vid: String(vid), ...(m3u8 ? { url: m3u8 } : {}) }];

  return { title, pic: picRaw, desc, actor, genreName, sources, episodes, tags: tagLinks.slice(0, 30) };
}

// 首页导航是分类+标签库（约 7 个 /videos/category/ + 约 68 个 /videos/tag/）。
// 内置 13 个只覆盖一部分，这里把导航全量并进来（24 小时缓存），按真实站点类别同步。
// 动态 id 用 `cat-<slug>` / `tag-<slug>` 字符串（框架层全走 String 比对，直通）。
// 与内置重复 path 的跳过。失败回退内置。
let navCatsLoadedAt = 0;
const NAV_TTL_MS = 24 * 3600 * 1000;

async function ensureNavCats(base, fetchFn) {
  const now = Date.now();
  if (now - navCatsLoadedAt < NAV_TTL_MS && CATS.length > 13) return;
  try {
    const url = (base || 'https://vip.aqdm888.com:20844').replace(/\/$/, '') + '/';
    const res = await fetchFn(url);
    if (!res.ok) return;
    const html = deobfuscate(await res.text());
    const $ = cheerio.load(html);
    const havePaths = new Set(CATS.map((c) => c.genre));
    const add = (type_id, type_name, genre, group) => {
      if (!genre || !type_name || havePaths.has(genre)) return;
      havePaths.add(genre);
      CATS.push({ type_id, type_name, genre, sort: '', group });
    };
    $('a[href^="/videos/category/"], a[href^="/videos/tag/"]').each((_, a) => {
      const href = ($(a).attr('href') || '').split('?')[0];
      const name = clean($(a).text());
      if (!name || name.length > 20) return;
      let m = href.match(/^\/videos\/category\/([a-z0-9_-]+)\.html$/i);
      if (m) {
        add(`cat-${m[1].toLowerCase()}`, name, `/videos/category/${m[1]}.html`, '地區');
        return;
      }
      m = href.match(/^\/videos\/tag\/([a-z0-9_-]+)\.html$/i);
      if (m) add(`tag-${m[1].toLowerCase()}`, name, `/videos/tag/${m[1]}.html`, '標籤');
    });
    navCatsLoadedAt = now;
  } catch {
    // 导航拉取/解析失败不影响列表：继续用内置 13 个
  }
}

module.exports = {
  key: 'aqdlt',
  displayName: '爱情岛',
  baseEnv: 'AQDLT_BASE',
  defaultBase: 'https://vip.aqdm888.com:20844',
  publicBaseEnv: 'PUBLIC_BASE_AQDLT',
  uaEnv: 'AQDLT_UA',
  passthrough: true, // 原生 m3u8 直传：列表不拼 /h/，详情用自带 url
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  ensureNavCats,
  detailUrl: (vid, base) => `${base}/videos/play/${vid}.html`,
  parseList,
  parsePageCount,
  parseDetail,
};
