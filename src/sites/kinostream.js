'use strict';

/**
 * kinostream (KINOSTREAM 台湾正版 VOD) 适配器。
 * 无反爬（直连抓取，无 CF），SSR，结构简单：
 *   首页 /vod：.main_swiper 行（.category-wrapper h2 分类名 + .swiper-slide.card a[href=/cloud/vod/<id>]）
 *   分类 /vod/category/<urlencoded名>：.con_post 网格（单页，无翻页）
 *   搜索 /cloud/search?term=<词>：同卡片结构
 *   详情 /cloud/vod/<id>：ld+json VideoObject（标题/简介/封面/演员）+ h5（級別/主演/導演），
 *     本页无播放器；播放 m3u8 在 /cloud/play/<id> 的内联播放器 JS 里
 *     （bitrates.hls / player.load），框架经 expandDetailUrl 自动跟进抓取。
 *     token 约 4 小时过期。
 *
 * 关键坑（见 README 6.21）：token 短效，开 skipHtmlCache（两页 HTML 都不缓存）+
 * detailTtlMs 1 小时，详情缓存只保标题封面这类静态字段，过期即重抓换新 token。
 */

const cheerio = require('cheerio'); // eslint-disable-line

const CATS = [
  { type_id: 1, type_name: '最新上架', genre: '最新上架' },
  { type_id: 2, type_name: '特別推薦', genre: '特別推薦' },
  { type_id: 3, type_name: '感官世界', genre: '感官世界' },
  { type_id: 4, type_name: 'B級特區', genre: 'B級特區' },
  { type_id: 5, type_name: '大眾娛樂', genre: '大眾娛樂' },
  { type_id: 6, type_name: '午夜狂熱', genre: '午夜狂熱' },
];

function catById(t) {
  return CATS.find((c) => String(c.type_id) === String(t));
}

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/vod',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function buildSearchUrl({ genre = '', query = '', pg = 1 }, base) {
  if (query) return `${base}/cloud/search?term=${encodeURIComponent(query)}`;
  if (genre) return `${base}/vod/category/${encodeURIComponent(genre)}`;
  void pg;
  return `${base}/vod`;
}

function parseList(html) {
  const $ = cheerio.load(html || '');
  const videos = [];
  const seen = new Set();
  $('a[href^="/cloud/vod/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/cloud\/vod\/(\d+)/);
    if (!m || seen.has(m[1])) return;
    const box = $(a).closest('.con_post, .swiper-slide, .card');
    const scope = box.length ? box : $(a).parent();
    const h1 = scope.find('h1').first().text().trim();
    const h3 = scope.find('h3').first().text().trim();
    const h4 = scope.find('h4').first().text().trim();
    const img = scope.find('img').first();
    const title = (h1 || h3 || img.attr('alt') || $(a).text() || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    seen.add(m[1]);
    videos.push({
      vid: m[1],
      title,
      pic: img.attr('data-src') || img.attr('src') || '',
      sub: h4 || '',
    });
  });
  return videos;
}

// 单页分类，无翻页
function parsePageCount(html, pg) {
  void html;
  return Math.max(1, parseInt(pg, 10) || 1);
}

function detailUrl(vid, base) {
  return `${base}/cloud/vod/${encodeURIComponent(String(vid))}`;
}

// 详情页只是元数据壳，真实 m3u8 在 /cloud/play/<id> 内联播放器 JS 里，框架自动跟进
function expandDetailUrl(metaHtml, vid, base) {
  void metaHtml;
  return `${base}/cloud/play/${encodeURIComponent(String(vid))}`;
}

function extractM3u8(html) {
  const m = String(html || '').match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
  return m ? m[0] : '';
}

function parseDetail(html, vid, playHtml) {
  const $ = cheerio.load(html || '');
  // 首选 ld+json VideoObject（标题/简介/封面/演员一次齐）
  let title = '';
  let desc = '';
  let pic = '';
  let actor = '';
  try {
    const ld = $('script[type="application/ld+json"]').first().text();
    if (ld) {
      const o = JSON.parse(ld);
      const v = Array.isArray(o) ? o.find((x) => x && x['@type'] === 'VideoObject') || o[0] : o;
      if (v) {
        title = String(v.name || '').replace(/\s*-\s*KINOSTREAM.*$/, '').trim();
        desc = String(v.description || '').trim();
        pic = String(v.thumbnailUrl || '').trim();
        actor = String(v.actor || '').trim();
      }
    }
  } catch { /* 回退 DOM 解析 */ }
  if (!title) {
    title =
      ($('.movie_box_inner h2').first().text() ||
        $('h1.title_head').first().text() ||
        $('h2').first().text() ||
        `video ${vid}`).replace(/\s+/g, ' ').trim();
  }
  if (!pic) {
    const m = String(html || '').match(
      /https:\/\/flicksbank\.console360\.net\/images\/\d+\/default\.jpg/
    );
    if (m) pic = m[0];
  }
  if (!desc) {
    desc = $('.moive_text p')
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean)
      .join('\n');
  }
  const h5texts = $('.movie_box_inner h5')
    .map((_, e) => $(e).text().trim())
    .get();
  let genreName = '';
  const tags = [];
  for (const t of h5texts) {
    const mm = t.match(/^級別\s*\|\s*(.+)$/);
    if (mm) {
      genreName = mm[1].trim();
      tags.push(genreName);
    }
  }
  if (!actor) {
    const a = h5texts.find((t) => /^主演\s*\|/.test(t));
    if (a) actor = a.replace(/^主演\s*\|\s*/, '').trim();
  }

  const m3u8 = extractM3u8(playHtml !== undefined ? playHtml : html);
  if (!m3u8) {
    // 播放页无 m3u8（站内下架/改版），本条无可播选集，不整单失败
    console.warn(`[kinostream] ${vid} 未提纯到 m3u8，本条无可播选集`);
  }
  return {
    title,
    pic,
    desc,
    actor,
    genreName,
    sources: m3u8 ? [{ src: m3u8 }] : [],
    episodes: m3u8 ? [{ name: '正片', url: m3u8, vid: String(vid) }] : [],
    tags,
  };
}

module.exports = {
  key: 'kinostream',
  displayName: 'KinoStream',
  baseEnv: 'KINOSTREAM_BASE',
  defaultBase: 'https://kinostream.com',
  publicBaseEnv: 'PUBLIC_BASE_KINOSTREAM',
  uaEnv: 'KINOSTREAM_UA',
  passthrough: true, // cdn.hinet 原生 m3u8 直传，框架原样透传
  skipHtmlCache: true, // 详情 HTML 内嵌短效 token，不缓存
  detailTtlMs: 3600 * 1000, // token 约 4 小时过期，详情缓存只保 1 小时
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  parseList,
  parsePageCount,
  detailUrl,
  expandDetailUrl,
  extractM3u8,
  parseDetail,
};
