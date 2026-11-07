'use strict';

/**
 * bjcam (sexbjcam.com, WordPress retrotube 录播站) 适配器。
 * WP 标准翻页：
 *   最新 /?filter=latest：大网格（单页上百卡）+ .pagination
 *   分类 /category/<slug>/：.con_post 网格 25 卡/页 + .pagination（/page/N/）
 *   搜索 /?s=<词>（翻页 /page/N/?s=<词>）：同一套卡片
 *   卡片 article.thumb-block a[href=/YYYY/MM/DD/slug]，vid 取 WP post id
 *     （article[data-post-id]，详情走 /?p=<id> 短链跟随跳转）
 * 详情：og:title/og:image + embed iframe，分新老两套播放器：
 *   新：video.playerrecord.cfd/e/<code>，流在 player API
 *     /app/v1/play/<code>?embed=1&ref= 的 JSON 里（hls/master.m3u8），
 *     框架经 expandDetailUrl 自动跟进抓取；
 *   老：playrecord.biz/embed/<code>（旧片），页内是 packer 混淆的 jwplayer 配置，
 *     解出 links.hls2（自带 token，优先）/hls4（相对路径，需 embed 域补全）/hls3，
 *     expand 直接返回 embed 页地址，parseDetail 解码提流。
 *     流地址含时效，列表/详情 HTML 走中转且照常缓存（省调用次数），
 *     二跳（player JSON/旧 embed 页）每次现抓（noCachePlayHtml）+ detailTtlMs 1 小时，
 *     详情缓存只保标题封面这类静态字段，过期即重抓换新流。
 * 注意：sexbjcam 主站对部分网络弹 CF 挑战，需配 SCRAPERAPI_KEY 走中转
 * （relayOnChallenge 先直连，挑战才转）；embed 及流地址域直连可达。
 */

const cheerio = require('cheerio'); // eslint-disable-line

const CATS = [
  { type_id: 1, type_name: '最新发布', genre: 'latest' },
  { type_id: 2, type_name: 'KOREAN BJ', genre: 'korean-bj' },
  { type_id: 3, type_name: 'CHINESE GIRL', genre: 'chinese-gril' },
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
    Referer: base + '/',
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function buildSearchUrl({ genre = '', query = '', pg = 1 }, base) {
  const page = Math.max(1, parseInt(pg, 10) || 1);
  if (query) {
    const q = `?s=${encodeURIComponent(query)}`;
    return page > 1 ? `${base}/page/${page}/${q}` : `${base}/${q}`;
  }
  if (genre && genre !== 'latest') {
    const u = `${base}/category/${encodeURIComponent(genre)}/`;
    return page > 1 ? `${u}page/${page}/` : u;
  }
  if (page > 1) return `${base}/page/${page}/?filter=latest`;
  return `${base}/?filter=latest`;
}

function parseList(html) {
  const $ = cheerio.load(html || '');
  const videos = [];
  const seen = new Set();
  $('article.thumb-block').each((_, art) => {
    const $art = $(art);
    const pid = String($art.attr('data-post-id') || '').trim();
    const a = $art.find('a[href]').first();
    const href = a.attr('href') || '';
    const m = href.match(/\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9\-_]+)\//i);
    if (!pid || !m || seen.has(pid)) return;
    const title = ($art.find('header.entry-header span').first().text() ||
      a.attr('title') || '').replace(/\s+/g, ' ').trim();
    if (!title) return;
    const img = $art.find('img.video-main-thumb, img').first();
    const dur = $art.find('.duration').first().text().replace(/\s+/g, '').trim();
    seen.add(pid);
    videos.push({
      vid: pid,
      title,
      pic: img.attr('data-src') || img.attr('src') || '',
      sub: dur,
    });
  });
  return videos;
}

// WP 标准翻页：.pagination 里 /page/N/ 取最大页码
function parsePageCount(html, pg) {
  const cur = Math.max(1, parseInt(pg, 10) || 1);
  const $ = cheerio.load(html || '');
  let max = cur;
  $('.pagination a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/page\/(\d+)\//);
    if (m) max = Math.max(max, parseInt(m[1], 10) || cur);
  });
  return Math.max(1, max);
}

function detailUrl(vid, base) {
  return `${base}/?p=${encodeURIComponent(String(vid))}`;
}

// expandDetailUrl 记下的旧 embed 页 origin（hls4 相对路径补全用），parse 后即删
const embedBaseByVid = new Map();

// Dean Edwards packer 解码（旧 embed 页的 jwplayer 配置用它混淆）
function unpackDeanEdwards(src) {
  const m = String(src || '').match(
    /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)\)/
  );
  if (!m) return '';
  let p = m[1];
  const a = parseInt(m[2], 10) || 36;
  let c = parseInt(m[3], 10) || 0;
  const k = String(m[4]).split('|');
  const alpha = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, a);
  const toBase = (n) => {
    if (!n) return '0';
    let s = '';
    while (n > 0) {
      s = alpha[n % a] + s;
      n = Math.floor(n / a);
    }
    return s;
  };
  while (c > 0) {
    c -= 1;
    if (c < k.length && k[c]) {
      // 必须带 \b 词边界（跟原 packer 一致），否则短码会污染已替换的长词
      p = p.replace(new RegExp(`\\b${toBase(c)}\\b`, 'g'), k[c]);
    }
  }
  return p;
}

// 旧 embed 页解出三路流地址（优先级 hls2 > hls4 > hls3 见下）
function extractOldEmbedStreams(playHtml) {
  const code = unpackDeanEdwards(playHtml);
  if (!code) return {};
  const out = {};
  const lm = code.match(/["'](hls\d)["']\s*:\s*"([^"]+)"/g) || [];
  for (const item of lm) {
    const mm = item.match(/["'](hls\d)["']\s*:\s*"([^"]+)"/);
    if (mm && !out[mm[1]]) out[mm[1]] = mm[2];
  }
  return out;
}

// 详情页只是元数据壳 + embed iframe，框架自动跟进：
// 新 embed（playerrecord.cfd）跟 player API 取 JSON；旧 embed（playrecord.biz）直接跟 embed 页
function expandDetailUrl(metaHtml, vid, base) {
  const src = String(metaHtml || '');
  const nm = src.match(/(https?:\/\/[^\s"'<>]+)\/e\/([A-Za-z0-9]+)/);
  if (nm) {
    const ref = encodeURIComponent(detailUrl(vid, base));
    return `${nm[1]}/app/v1/play/${nm[2]}?embed=1&ref=${ref}`;
  }
  const om = src.match(/(https?:\/\/[^\s"'<>]*playrecord\.biz)\/embed\/([A-Za-z0-9]+)/);
  if (om) {
    embedBaseByVid.set(String(vid), om[1]);
    return `${om[1]}/embed/${om[2]}`;
  }
  return '';
}

function parseDetail(html, vid, playHtml) {
  const $ = cheerio.load(html || '');
  const og = (p) => ($(`meta[property="${p}"]`).attr('content') || '').trim();
  let title = og('og:title');
  if (!title) {
    title = ($('title').first().text() || '').replace(/\s*[–—-]\s*sexbjcam\s*$/i, '').replace(/\s+/g, ' ').trim();
  }
  if (!title) title = `video ${vid}`;
  const pic = og('og:image');
  const desc = og('og:description');
  const cats = [];
  $('a[href*="/category/"]').each((_, a) => {
    const t = $(a).text().trim();
    if (t && !cats.includes(t)) cats.push(t);
  });
  const actors = [];
  $('a[href*="/actors/"]').each((_, a) => {
    const t = $(a).text().trim();
    if (t && !actors.includes(t)) actors.push(t);
  });

  // 播放页二选一：
  // A. 新 embed 的 player API JSON（hls 优先，mp4 兜底）
  // B. 旧 embed 页：解 packer 拿 links（hls2 自带 token 优先，hls4 相对路径用 embed 域补全，hls3 兜底）
  let stream = '';
  let streamPoster = '';
  const playText = String(playHtml !== undefined ? playHtml : '');
  const trimmed = playText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j === 'object') {
        stream = String(j.hls || j.mp4 || '').trim();
        streamPoster = String(j.poster || '').trim();
      }
    } catch {
      /* 走下面正则兜底 */
    }
  }
  if (!stream && (playText.includes('jwplayer') || playText.includes('.urlset/'))) {
    const links = extractOldEmbedStreams(playText);
    const base = embedBaseByVid.get(String(vid)) || '';
    embedBaseByVid.delete(String(vid));
    stream =
      String(links.hls2 || '').trim() ||
      (String(links.hls4 || '').trim()
        ? String(links.hls4).trim().startsWith('http')
          ? String(links.hls4).trim()
          : base + String(links.hls4).trim()
        : '') ||
      String(links.hls3 || '').trim();
  }
  if (!stream) {
    const m2 = playText.match(
      /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/
    ) ||
      playText.match(
        /https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/
      ) ||
      String(html || '').match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
    if (m2) stream = m2[0];
  }
  if (!stream) {
    console.warn(`[bjcam] ${vid} 未提纯到播放流，本条无可播选集`);
  }
  return {
    title,
    pic: pic || streamPoster,
    desc,
    actor: actors.join(', '),
    genreName: cats[0] || '',
    sources: stream ? [{ src: stream }] : [],
    episodes: stream ? [{ name: '正片', url: stream, vid: String(vid) }] : [],
    tags: cats,
  };
}

module.exports = {
  key: 'bjcam',
  displayName: 'BJ剧场',
  baseEnv: 'BJCAM_BASE',
  defaultBase: 'https://sexbjcam.com',
  publicBaseEnv: 'PUBLIC_BASE_BJCAM',
  uaEnv: 'BJCAM_UA',
  passthrough: true, // 录播站原生 hls/mp4 直传，框架原样透传
  useRelay: true, // 整站被 CF 拦截时走 ScraperAPI render 中转（需 SCRAPERAPI_KEY）
  relayOnChallenge: true, // 先直连试一次（换干净 IP 可能直接过，免 key 零成本），遇 CF 挑战再转中转
  directHosts: ['video.playerrecord.cfd', 'playrecord.biz'], // 播放相关域无 CF，可直连（省中转费）
  noCachePlayHtml: true, // player JSON 含短效流（约 4 小时），二跳每次现抓；列表/详情 HTML 照常缓存
  detailTtlMs: 3600 * 1000, // 流约 4 小时过期，详情缓存只保 1 小时
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  parseList,
  parsePageCount,
  detailUrl,
  expandDetailUrl,
  extractOldEmbedStreams,
  parseDetail,
  unpackDeanEdwards,
};
