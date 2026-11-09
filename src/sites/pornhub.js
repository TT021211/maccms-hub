'use strict';

/**
 * pornhub 专用站点适配器（https://cn.pornhub.com，匿名可抓，无需登录）。
 * 列表/搜索/分类全是服务端渲染，直连抓取（VPS 实测为准，若遇拦截再按 bjcam 套路加中转）：
 *   搜索: /video/search?search=<词>&page=<pg>（页内嵌 "maxPages":N JSON）
 *   分类: 数字类 /video?c=<id>?page=<pg>；slug 类 /categories/<slug>?page=<pg>
 *   详情: /view_video.php?viewkey=<vkey>（vid 取 data-video-vkey 全段）
 *   播放：页内 mediaDefinitions JSON 给多档 HLS（ev-h.phncdn.com，signed，约 2h 有效），
 *     passthrough 取最高档直传。token 短效：skipHtmlCache + detailTtlMs=1h，
 *     /play 与 /h/ 链路本就每次现抓（resolveMp4 绕缓存）。
 * 环境变量：PORNHUB_BASE（默认 https://cn.pornhub.com）
 */

const cheerio = require('cheerio');

// genre: 纯数字走 /video?c=；字母 slug 走 /categories/
const CATS = [
  { type_id: 1, type_name: '日本人', genre: '111' },
  { type_id: 2, type_name: '熟女', genre: '28' },
  { type_id: 3, type_name: '辣妈', genre: '29' },
  { type_id: 4, type_name: '巨乳', genre: '8' },
  { type_id: 5, type_name: '女同', genre: '27' },
  { type_id: 6, type_name: '爆菊', genre: '35' },
  { type_id: 7, type_name: '3P', genre: '65' },
  { type_id: 8, type_name: '内射', genre: '15' },
  { type_id: 9, type_name: '潮吹', genre: '69' },
  { type_id: 10, type_name: '捆绑', genre: '10' },
  { type_id: 11, type_name: '日漫', genre: 'hentai' },
  { type_id: 12, type_name: '少女', genre: 'teen' },
];

const catById = (t) => CATS.find((c) => String(c.type_id) === String(t));

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  void sort;
  const page = Math.max(1, parseInt(pg, 10) || 1);
  if (query) {
    let url = `${base}/video/search?search=${encodeURIComponent(query)}`;
    if (page > 1) url += `&page=${page}`;
    return url;
  }
  const g = String(genre);
  let url;
  if (/^\d+$/.test(g)) url = `${base}/video?c=${g}`;
  else if (/^[a-z0-9-]+$/.test(g)) url = `${base}/categories/${g}`;
  else url = `${base}/video?c=111`;
  if (page > 1) url += (url.includes('?') ? '&' : '?') + `page=${page}`;
  return url;
}

// 卡片：li.pcVideoListItem[data-video-vkey]，标题在缩略图锚点的 title，封面 pix-cdn 直链
function parseList(html) {
  const $ = cheerio.load(html || '');
  const videos = [];
  const seen = new Set();
  $('li.pcVideoListItem[data-video-vkey]').each((_, el) => {
    const vkey = clean($(el).attr('data-video-vkey'));
    if (!vkey || !/^[a-z0-9]+$/i.test(vkey) || seen.has(vkey)) return;
    const a = $(el).find('a[href*="viewkey="]').first();
    const title =
      clean(a.attr('title')) ||
      clean($(el).find('img').first().attr('alt')) ||
      clean($(el).find('a[title]').first().attr('title'));
    if (!title) return;
    let pic = '';
    $(el)
      .find('img')
      .each((_, img) => {
        if (pic) return;
        const s = $(img).attr('src') || $(img).attr('data-src') || '';
        if (!s || /^data:/i.test(s)) return;
        pic = s.startsWith('//') ? 'https:' + s : s;
      });
    seen.add(vkey);
    videos.push({ vid: vkey, title: title.slice(0, 120), pic });
  });
  return videos;
}

// 搜索页内嵌 "maxPages":N；分类页看翻页按钮 data-page/文本取最大
function parsePageCount(html, pg) {
  const t = String(html || '');
  let m = t.match(/"maxPages"\s*:\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n >= 1) return Math.min(n, 5000);
  }
  let max = parseInt(pg, 10) || 1;
  const $ = cheerio.load(t);
  $('li.page_number a').each((_, a) => {
    const n = parseInt(clean($(a).text()).replace(/,/g, ''), 10);
    if (!isNaN(n) && n > max && n < 100000) max = Math.min(n, 5000);
  });
  const re = /data-page="(\d+)"/g;
  let mm;
  while ((mm = re.exec(t))) {
    const n = parseInt(mm[1], 10);
    if (!isNaN(n) && n > max && n < 100000) max = Math.min(n, 5000);
  }
  return max;
}

function detailUrl(vid, base) {
  return `${base}/view_video.php?viewkey=${encodeURIComponent(String(vid))}`;
}

// mediaDefinitions JSON：按清晰度降序，取最高档（sources[0] 即最高，框架拿它 302）
function extractSources(html) {
  const t = String(html || '').replace(/\\\//g, '/');
  const found = [];
  const re = /"quality"\s*:\s*"(\d+)"\s*,\s*"videoUrl"\s*:\s*"(https:[^"]+?\.m3u8[^"]*)"/g;
  let m;
  while ((m = re.exec(t))) {
    const q = parseInt(m[1], 10) || 0;
    const src = m[2].replace(/[\\,;)\]]+$/, '');
    if (/^https:\/\//i.test(src)) found.push({ size: q, src });
  }
  found.sort((a, b) => b.size - a.size);
  const seen = new Set();
  return found.filter((s) => (seen.has(s.src) ? false : (seen.add(s.src), true)));
}

function parseDetail(html, vid) {
  const $ = cheerio.load(html || '');
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean(og('title')).slice(0, 120);
  if (!title) {
    const t = clean($('title').first().text());
    const m = t.match(/(?:完整视频\s*-\s*)?(.+?)\s*[|｜-]\s*Pornhub/i) || t.match(/(.+?)\s*[|｜]/);
    title = clean(m ? m[1] : t).slice(0, 120);
  }
  if (!title) title = `pornhub ${vid}`;
  let pic = og('image') || '';
  if (!pic) {
    const img = $('img[src*="phncdn"]').first().attr('src') || '';
    if (img && !/^data:/i.test(img)) pic = img.startsWith('//') ? 'https:' + img : img;
  }
  const desc = clean(og('description'));
  const actor = $('a[href*="/pornstar/"], a[href*="/model/"]')
    .map((_, a) => clean($(a).text()))
    .get()
    .filter((s) => s && s.length <= 40)
    .slice(0, 6)
    .join(',');
  const tags = $('a[href*="/categories/"]')
    .map((_, a) => clean($(a).text()))
    .get()
    .filter((s) => s && s.length > 1 && s.length <= 20)
    .slice(0, 12);
  const sources = extractSources(html);
  const episodes = sources.length
    ? [{ name: '正片', url: sources[0].src, vid: String(vid) }]
    : [{ name: '正片', vid: String(vid) }];
  return { title, pic, desc, actor, genreName: tags[0] || '', sources, episodes, tags };
}

module.exports = {
  key: 'pornhub',
  displayName: 'Pornhub',
  baseEnv: 'PORNHUB_BASE',
  defaultBase: 'https://cn.pornhub.com',
  publicBaseEnv: 'PUBLIC_BASE_PORNHUB',
  passthrough: true, // 原生多档 m3u8 直传：列表不拼 /h/，详情用自带最高档 url
  skipHtmlCache: true, // 直链签名约 2h 过期，详情/播放页都不缓存 HTML
  detailTtlMs: 3600 * 1000, // 详情信封只保 1h，过期重抓换新签名
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  detailUrl,
  expandDetailUrl: null,
  parseList,
  parsePageCount,
  parseDetail,
};
