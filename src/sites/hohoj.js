'use strict';

/**
 * hohoj 专用站点适配器（https://hohoj.tv）。
 * 详情页只是个壳（标题/封面），真实播放地址在内嵌 iframe `/embed?id=<vid>` 里，
 * 框架经 expandDetailUrl 自动跟进抓子页；子页内是原生 m3u8（video-*.ggjav.com），
 * passthrough 直传，无需转封装/中转，直连可达。
 * 环境变量：HOHOJ_BASE / HOHOJ_UA（默认 https://hohoj.tv）
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '最新更新', genre: '', sort: '', group: '精選' },
  { type_id: 2, type_name: '無碼', genre: '/search?type=uncensored', sort: '', group: '類型' },
  { type_id: 3, type_name: '中文字幕', genre: '/search?type=chinese', sort: '', group: '類型' },
  { type_id: 4, type_name: '歐美', genre: '/search?type=europe', sort: '', group: '類型' },
  { type_id: 5, type_name: '有碼', genre: '/search?type=censored', sort: '', group: '類型' },
  { type_id: 6, type_name: '制服誘惑', genre: '/main_ctg?id=4', sort: '', group: '主題' },
  { type_id: 7, type_name: '巨乳美乳', genre: '/main_ctg?id=9', sort: '', group: '主題' },
  { type_id: 8, type_name: '角色劇情', genre: '/main_ctg?id=6', sort: '', group: '主題' },
  { type_id: 9, type_name: '出軌', genre: '/main_ctg?id=7', sort: '', group: '主題' },
  { type_id: 10, type_name: '亂倫', genre: '/main_ctg?id=8', sort: '', group: '主題' },
  { type_id: 11, type_name: '多P群交', genre: '/main_ctg?id=5', sort: '', group: '主題' },
  { type_id: 12, type_name: '主奴調教', genre: '/main_ctg?id=3', sort: '', group: '主題' },
  { type_id: 13, type_name: '絲襪美腿', genre: '/main_ctg?id=1', sort: '', group: '主題' },
];

const catById = (t) => CATS.find((c) => String(c.type_id) === String(t));

const UA_LIST = [
  process.env.HOHOJ_UA || '',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
].filter(Boolean);

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/',
    'Accept-Language': 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 列表/分类地址（genre 存完整 path）。搜索走 /search?text=（已验证返回过滤结果）。
function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  void sort;
  let url;
  if (query) url = `${base}/search?text=${encodeURIComponent(query)}`;
  else if (genre) url = `${base}${genre.startsWith('/') ? genre : '/' + genre}`;
  else url = `${base}/`;
  // 站内翻页参数是 p（分页是 changePage(N) 跳转），不是 page
  if (pg > 1) url += (url.includes('?') ? '&' : '?') + `p=${pg}`;
  return url;
}

function detailUrl(vid, base) {
  return `${base}/video?id=${encodeURIComponent(vid)}`;
}

// 详情页里的播放器是 iframe，子页才有 m3u8
function expandDetailUrl(metaHtml, vid, base) {
  void vid;
  const m = metaHtml.match(/<iframe[^>]+src="([^"]*embed[^"]*)"/i);
  if (!m) return null;
  try {
    return new URL(m[1], base).href;
  } catch {
    return null;
  }
}

// 详情链接：/video?id=7557（相对/绝对都认）
function normVid(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return '';
  let p = '';
  let host = '';
  if (href.startsWith('/')) {
    p = href;
    try {
      host = new URL(base || 'https://hohoj.tv').hostname;
    } catch {
      host = '';
    }
  } else {
    try {
      const u = new URL(href, base || 'https://hohoj.tv');
      host = u.hostname;
      p = u.pathname + u.search;
    } catch {
      return '';
    }
    if (!p) return '';
  }
  if (host && !/hohoj\.tv$/i.test(host)) return '';
  const m = p.split('#')[0].match(/[?&]id=(\d+)/);
  return m ? m[1] : '';
}

function pickPic($, anchor) {
  const urls = [];
  anchor.find('img').each((_, img) => {
    for (const a of ['data-src', 'data-original', 'src']) {
      const s = $(img).attr(a) || '';
      if (!s || /icon|avatar|logo|placeholder|loading|blank|grey/i.test(s)) continue;
      urls.push(s.startsWith('//') ? 'https:' + s : s);
    }
  });
  return urls[0] || '';
}

function parseList(html) {
  const $ = cheerio.load(html);
  const byVid = new Map();
  $('a[href]').each((_, a) => {
    const vid = normVid($(a).attr('href') || '', '');
    if (!vid) return;
    const inner = $(a);
    const title =
      clean(inner.attr('title') || '') ||
      clean(inner.find('img').first().attr('alt') || '') ||
      clean(inner.text()).slice(0, 120);
    if (!title) return;
    const pic = pickPic($, inner);
    const cur = byVid.get(vid) || { vid, title: '', pic: '' };
    if (title.length > cur.title.length) cur.title = title;
    if (pic && !cur.pic) cur.pic = pic;
    byVid.set(vid, cur);
  });
  return [...byVid.values()].filter((v) => v.title);
}

function parsePageCount(html, pg) {
  const text = html;
  let max = pg;
  const m = text.match(/共\s*(\d+)\s*页/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = Math.min(n, 500);
  }
  // 站内分页是 javascript:changePage(N)（最后页链接即总页数），没有 ?page= 写法
  const pats = [/[?&]page=(\d+)/g, /\/page\/(\d+)/g, /changePage\((\d+)\)/g];
  for (const re of pats) {
    let mm;
    while ((mm = re.exec(text))) {
      const n = parseInt(mm[1], 10);
      if (!isNaN(n) && n > max && n < 10000) max = Math.min(n, 500);
    }
  }
  return max;
}

const M3U8_RE = /https?:\/\/[^\s"'<>]*?\.m3u8[^\s"'<>]*/i;

function parseDetail(html, vid, playHtml) {
  const $ = cheerio.load(html);
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean($('h1').first().text()).slice(0, 120);
  if (!title) title = clean(og('title').replace(/\s*[-–|]\s*HoHoJ.*$/i, ''));
  if (!title) title = clean($('title').first().text()).slice(0, 120);
  if (!title) title = `hohoj ${vid}`;
  const picRaw = og('image') || '';
  const desc = clean(og('description'));

  let actor = '';
  const tagLinks = [];
  let genreName = '';
  $('a[href*="/model"], a[href*="/search"], a[href*="/main_ctg"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const t = clean($(a).text());
    if (!t || t.length > 20 || tagLinks.includes(t)) return;
    tagLinks.push(t);
    if (!genreName && /\/model|\/main_ctg/.test(href)) genreName = t;
  });

  const src = (playHtml || '') + '\n' + html;
  const m = src.match(M3U8_RE);
  const m3u8 = m ? m[0].replace(/[\\,;)\]]+$/, '') : '';
  const sources = m3u8 ? [{ size: 0, src: m3u8 }] : [];
  const episodes = [{ name: '正片', vid: String(vid), ...(m3u8 ? { url: m3u8 } : {}) }];

  return { title, pic: picRaw, desc, actor, genreName, sources, episodes, tags: tagLinks.slice(0, 30) };
}

// 站内导航（/extra_info 的 nav_collapse）是个大标签库：12 个 /main_ctg 主题 + 约 570 个
// /ctg 标签。内置 13 个 CATS 只覆盖一小部分，这里把导航全量并进来（24 小时缓存），
// 按真实站点类别同步。动态 id 用数字偏移避开内置 1-13：main_ctg 缺的 4 个 → 1000+N，
// ctg 全量 → 2000+N。与内置重复 path 的跳过（如 main_ctg?id=8 已有 亂倫）。
let navCatsLoadedAt = 0;
const NAV_TTL_MS = 24 * 3600 * 1000;

async function ensureNavCats(base, fetchFn) {
  const now = Date.now();
  if (now - navCatsLoadedAt < NAV_TTL_MS && CATS.length > 13) return;
  try {
    const url = (base || 'https://hohoj.tv').replace(/\/$/, '') + '/extra_info';
    const res = await fetchFn(url);
    if (!res.ok) return;
    const data = await res.json();
    const nav = (data && data.nav_collapse) || '';
    if (!nav) return;
    const havePaths = new Set(CATS.map((c) => c.genre));
    const seen = new Set();
    const add = (type_id, type_name, genre, group) => {
      if (!genre || havePaths.has(genre) || seen.has(genre)) return;
      seen.add(genre);
      havePaths.add(genre);
      CATS.push({ type_id, type_name, genre, sort: '', group });
    };
    const re = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = re.exec(nav))) {
      const href = m[1];
      const name = (m[2] || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length > 20) continue;
      let mm = href.match(/^\/main_ctg\?id=(\d+)/i);
      if (mm) {
        add(1000 + parseInt(mm[1], 10), name, `/main_ctg?id=${mm[1]}`, '主題');
        continue;
      }
      mm = href.match(/^\/ctg\?id=(\d+)/i);
      if (mm) add(2000 + parseInt(mm[1], 10), name, `/ctg?id=${mm[1]}`, '標籤');
    }
    navCatsLoadedAt = now;
  } catch {
    // 导航拉取失败不影响列表：继续用内置 13 个
  }
}

// 人物墙 /all_models（order=popular|views，p 翻页）与人物作品页 /model?id=N（p 翻页，
// 与列表页同一套 video-item 结构 + changePage 分页，可复用 parseList/parsePageCount）。
function parseModels(html) {
  const $ = cheerio.load(html);
  const models = [];
  const seen = new Set();
  $('.model').each((_, el) => {
    const a = $(el).find('a[href*="/model?id="]').first();
    const m = (a.attr('href') || '').match(/[?&]id=(\d+)/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    const pic = a.find('img').first().attr('src') || '';
    const name = clean($(el).find('.model-name').first().text()) || clean(a.text());
    if (!name) return;
    models.push({ mid: m[1], name, pic: pic.startsWith('//') ? 'https:' + pic : pic });
  });
  return models;
}

function buildModelsUrl({ order = 'popular', pg = 1 }, base) {
  let url = `${base}/all_models?order=${order === 'views' ? 'views' : 'popular'}`;
  if (pg > 1) url += `&p=${pg}`;
  return url;
}

function buildModelUrl({ mid, pg = 1 }, base) {
  let url = `${base}/model?id=${encodeURIComponent(mid)}`;
  if (pg > 1) url += `&p=${pg}`;
  return url;
}

// 站内直连抓取（简化版 UA 轮换：hohoj 无 CF，取前 3 个 UA 重试足够）
async function fetchModelHtml(site, url) {
  const uas = (site.def.UA_LIST || []).filter(Boolean);
  const list = uas.length ? uas : ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'];
  let lastErr = null;
  for (const ua of list.slice(0, 3)) {
    try {
      const res = await fetch(url, { headers: site.def.headersFor(ua, site.base), signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`upstream http ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed for ' + url);
}

function fmtTime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ac=models / ac=model-videos：走 MacCMS 信封，人物本身映射成 vod 条目
//（vod_id=`model-<mid>`，MoonPlayer 侧以此外缀识别走 model-videos 通道）。
async function handleModels(site, req, res, ac) {
  const q = req.query;
  const pg = Math.max(1, parseInt(q.pg || q.page || q.p || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || q.pagesize || '20', 10) || 20));
  try {
    if (ac === 'models') {
      const order = q.order === 'views' ? 'views' : 'popular';
      const html = await fetchModelHtml(site, buildModelsUrl({ order, pg }, site.base));
      const models = parseModels(html);
      const pagecount = Math.max(pg, site.def.parsePageCount(html, pg));
      const list = models.slice(0, limit).map((v) => ({
        vod_id: `model-${v.mid}`,
        vod_name: v.name,
        type_id: 0,
        type_name: '女优',
        vod_pic: v.pic,
        vod_remarks: '',
        vod_time: fmtTime(),
        vod_play_from: site.def.displayName,
        vod_play_url: undefined,
      }));
      return res.json({ code: 1, msg: '数据列表', page: pg, pagecount, limit, total: pagecount * limit, list });
    }
    const mid = String(q.mid || '').replace(/^model-/, '');
    if (!mid) return res.status(400).json({ code: 0, msg: 'missing ?mid=' });
    const html = await fetchModelHtml(site, buildModelUrl({ mid, pg }, site.base));
    const items = site.def.parseList(html);
    const pagecount = Math.max(pg, site.def.parsePageCount(html, pg));
    const list = items.slice(0, limit).map((v) => ({
      vod_id: v.vid,
      vod_name: v.title,
      type_id: 0,
      type_name: '女优作品',
      vod_pic: v.pic,
      vod_remarks: '',
      vod_time: fmtTime(),
      vod_play_from: site.def.displayName,
      vod_play_url: undefined,
    }));
    return res.json({ code: 1, msg: '数据列表', page: pg, pagecount, limit, total: pagecount * limit, list });
  } catch (e) {
    return res.status(502).json({ code: 0, msg: '上游抓取失败: ' + (e.message || e) });
  }
}

module.exports = {
  key: 'hohoj',
  displayName: 'HoHoJ',
  baseEnv: 'HOHOJ_BASE',
  defaultBase: 'https://hohoj.tv',
  publicBaseEnv: 'PUBLIC_BASE_HOHOJ',
  uaEnv: 'HOHOJ_UA',
  passthrough: true, // 原生 m3u8 直传：列表不拼 /h/，详情用自带 url
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  ensureNavCats,
  parseModels,
  buildModelsUrl,
  buildModelUrl,
  handleModels,
  detailUrl,
  expandDetailUrl,
  parseList,
  parsePageCount,
  parseDetail,
};
