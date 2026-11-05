'use strict';

/**
 * HoHoJ 站点适配器（https://hohoj.tv）。
 * 详情页只是个壳（标题/封面），真实播放地址在内嵌 iframe `/embed?id=<vid>` 里，
 * 框架经 expandDetailUrl 自动跟进抓子页；子页内是原生 m3u8（video-*.ggjav.com），
 * passthrough 直传，无需转封装/中转，直连可达。
 * 环境变量：HOHOJ_BASE / HOHOJ_UA（默认 https://hohoj.tv）
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '最新更新', genre: '', sort: '' },
  { type_id: 2, type_name: '無碼', genre: '/search?type=uncensored', sort: '' },
  { type_id: 3, type_name: '中文字幕', genre: '/search?type=chinese', sort: '' },
  { type_id: 4, type_name: '歐美', genre: '/search?type=europe', sort: '' },
  { type_id: 5, type_name: '有碼', genre: '/search?type=censored', sort: '' },
  { type_id: 6, type_name: '制服誘惑', genre: '/main_ctg?id=4', sort: '' },
  { type_id: 7, type_name: '巨乳美乳', genre: '/main_ctg?id=9', sort: '' },
  { type_id: 8, type_name: '角色劇情', genre: '/main_ctg?id=6', sort: '' },
  { type_id: 9, type_name: '出軌', genre: '/main_ctg?id=7', sort: '' },
  { type_id: 10, type_name: '亂倫', genre: '/main_ctg?id=8', sort: '' },
  { type_id: 11, type_name: '多P群交', genre: '/main_ctg?id=5', sort: '' },
  { type_id: 12, type_name: '主奴調教', genre: '/main_ctg?id=3', sort: '' },
  { type_id: 13, type_name: '絲襪美腿', genre: '/main_ctg?id=1', sort: '' },
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
  if (pg > 1) url += (url.includes('?') ? '&' : '?') + `page=${pg}`;
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
  const pats = [/[?&]page=(\d+)/g, /\/page\/(\d+)/g];
  for (const re of pats) {
    let mm;
    while ((mm = re.exec(text))) {
      const n = parseInt(mm[1], 10);
      if (!isNaN(n) && n > max && n < 10000) max = n;
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
  detailUrl,
  expandDetailUrl,
  parseList,
  parsePageCount,
  parseDetail,
};
