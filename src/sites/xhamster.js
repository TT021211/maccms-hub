'use strict';

/**
 * xhamster 专用站点适配器（https://xhamster.com）。
 * Nuxt SSR，直连抓取：列表/搜索/分类全是服务端渲染，无需中转（VPS 实测为准，
 * 若遇拦截再按 bjcam 套路加 useRelay/relayOnChallenge）。
 *   搜索: /search/<词>?page=<pg>（站内分页即 ?page=，页内嵌 `"maxPages":N` JSON 拿总页数）
 *   分类: /categories/<slug>/<pg>（路径翻页；pg=1 省略 /1）
 *   详情: /videos/<slug>-<id>（vid 取 slug-id 全段，纯数字 id 拼不出详情页）
 *   播放：详情页 head 里直接预加载原生多码率 m3u8（video-nss.xhcdn.com，token 长效），
 *     passthrough 直传，无需转封装/二跳。
 * 环境变量：XHAMSTER_BASE（默认 https://xhamster.com）
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '日本', genre: 'japanese' },
  { type_id: 2, type_name: '亚洲', genre: 'asian' },
  { type_id: 3, type_name: 'JAV', genre: 'jav' },
  { type_id: 4, type_name: '素人', genre: 'amateur' },
  { type_id: 5, type_name: '自拍', genre: 'homemade' },
  { type_id: 6, type_name: '拉拉', genre: 'lesbian' },
  { type_id: 7, type_name: '肛交', genre: 'anal' },
  { type_id: 8, type_name: '中出', genre: 'creampie' },
  { type_id: 9, type_name: '妈妈', genre: 'mom' },
  { type_id: 10, type_name: '熟女', genre: 'mature' },
  { type_id: 11, type_name: '口交', genre: 'blowjob' },
  { type_id: 12, type_name: 'POV', genre: 'pov' },
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
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 搜索与分类翻页形式不同：搜索 ?page=，分类 /<pg> 路径（pg=1 省略）
function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  void sort;
  const page = Math.max(1, parseInt(pg, 10) || 1);
  if (query) {
    let url = `${base}/search/${encodeURIComponent(query)}`;
    if (page > 1) url += `?page=${page}`;
    return url;
  }
  const slug = (/^[a-z0-9-]+$/.test(String(genre)) && String(genre)) || 'japanese';
  let url = `${base}/categories/${slug}`;
  if (page > 1) url += `/${page}`;
  return url;
}

function detailUrl(vid, base) {
  return `${base}/videos/${encodeURIComponent(String(vid))}`;
}

// 卡片：.video-thumb[data-video-id]，标题在缩略图锚点的 aria-label，时长另有 duration 节点
function parseList(html) {
  const $ = cheerio.load(html || '');
  const videos = [];
  const seen = new Set();
  $('.video-thumb[data-video-id]').each((_, el) => {
    const box = $(el);
    const a = box.find('a[href*="/videos/"]').first();
    const m = (a.attr('href') || '').match(/\/videos\/([a-zA-Z0-9-]+?)-(\d+)(?:[/?#]|$)/);
    if (!m || seen.has(m[2])) return;
    const title =
      clean(a.attr('aria-label')) ||
      clean(a.find('img').first().attr('alt')) ||
      clean(box.find('a[title]').first().attr('title'));
    if (!title) return;
    let pic = '';
    box.find('img').each((_, img) => {
      if (pic) return;
      const s = $(img).attr('src') || $(img).attr('data-src') || '';
      if (!s || /^data:/i.test(s)) return;
      pic = s.startsWith('//') ? 'https:' + s : s;
    });
    seen.add(m[2]);
    videos.push({ vid: `${m[1]}-${m[2]}`, title: title.slice(0, 120), pic });
  });
  return videos;
}

// 站内 Nuxt 载荷自带 "maxPages":N；没有则从翻页按钮 data-page 取最大
function parsePageCount(html, pg) {
  const t = String(html || '');
  let m = t.match(/"maxPages"\s*:\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n >= 1) return Math.min(n, 5000);
  }
  let max = parseInt(pg, 10) || 1;
  const re = /data-page="(\d+)"/g;
  let mm;
  while ((mm = re.exec(t))) {
    const n = parseInt(mm[1], 10);
    if (!isNaN(n) && n > max && n < 100000) max = Math.min(n, 5000);
  }
  return max;
}

function parseDetail(html, vid) {
  const $ = cheerio.load(html || '');
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean(og('title')).slice(0, 120);
  if (!title) title = clean($('title').first().text().split('|')[0].split('-')[0]).slice(0, 120);
  if (!title) title = `xhamster ${vid}`;
  const pic = og('image') || '';
  const descRaw = clean(og('description'));
  let actor = '';
  let genreName = '';
  let tags = [];
  let m = descRaw.match(/Starring:\s*([^\.]+)/);
  if (m) actor = clean(m[1].replace(/\.$/, ''));
  m = descRaw.match(/Category:\s*([^\.]+)/);
  if (m) {
    tags = clean(m[1])
      .split(',')
      .map((s) => clean(s))
      .filter((s) => s && s.length <= 24)
      .slice(0, 12);
    genreName = tags[0] || '';
  }
  if (!tags.length) {
    tags = $('a[href*="/categories/"]')
      .map((_, a) => clean($(a).text()))
      .get()
      .filter((s) => s && s.length > 1 && s.length <= 24)
      .slice(0, 12);
    if (!genreName) genreName = tags[0] || '';
  }
  const src = String(html || '');
  const mm = src.match(/https:\/\/[^\s"'<>]*?\.m3u8[^\s"'<>]*/i);
  const m3u8 = mm ? mm[0].replace(/[\\,;)\]]+$/, '') : '';
  const sources = m3u8 ? [{ src: m3u8 }] : [];
  const episodes = [{ name: '正片', vid: String(vid), ...(m3u8 ? { url: m3u8 } : {}) }];
  return { title, pic, desc: descRaw, actor, genreName, sources, episodes, tags };
}

module.exports = {
  key: 'xhamster',
  displayName: 'xHamster',
  baseEnv: 'XHAMSTER_BASE',
  defaultBase: 'https://xhamster.com',
  publicBaseEnv: 'PUBLIC_BASE_XHAMSTER',
  passthrough: true, // 原生多码率 m3u8 直传：列表不拼 /h/，详情用自带 url
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
