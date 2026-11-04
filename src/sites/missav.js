'use strict';

/**
 * MissAV 站点适配器（https://missav.ai）。
 * 特点：详情页内联脚本含 UUID → 正片直链 https://surrit.com/<UUID>/playlist.m3u8，
 * 原生 m3u8，无需 ffmpeg 转封装 → 本适配器 passthrough: true，
 * 框架直接透传上游 m3u8，不拼 /h/ 地址（见 src/server.js）。
 * 环境变量：MISSAV_BASE / MISSAV_UA（默认 https://missav.ai）
 *
 * 注意：missav.ai 有 Cloudflare Managed Challenge，机房 IP 纯 HTTP 会被拦。
 * 若列表抓到 0 条，先在网关容器里跑：
 *   node -e "fetch('https://missav.ai/dm539/new',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.text()).then(t=>console.log(t.length))"
 * 长度只有几千且含 Just a moment = 被拦，适配器再对也出不来数据。
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '最新更新', genre: '/new', sort: '' },
  { type_id: 2, type_name: '新作上市', genre: '/release', sort: '' },
  { type_id: 3, type_name: '無碼流出', genre: '/uncensored-leak', sort: '' },
  { type_id: 4, type_name: '中文字幕', genre: '/chinese-subtitle', sort: '' },
  { type_id: 5, type_name: '今日熱門', genre: '/dm301/today-hot', sort: '' },
  { type_id: 6, type_name: '本週熱門', genre: '/dm170/weekly-hot', sort: '' },
  { type_id: 7, type_name: '本月熱門', genre: '/dm273/monthly-hot', sort: '' },
  { type_id: 8, type_name: 'VR', genre: '/genres/VR', sort: '' },
  { type_id: 9, type_name: 'FC2', genre: '/dm597/fc2', sort: '' },
  { type_id: 10, type_name: '東京熱', genre: '/dm42/tokyohot', sort: '' },
  { type_id: 11, type_name: '一本道', genre: '/dm4551174/1pondo', sort: '' },
  { type_id: 12, type_name: '加勒比海', genre: '/dm6840521/caribbeancom', sort: '' },
  { type_id: 13, type_name: '麻豆傳媒', genre: '/dm63/madou', sort: '' },
];

const catById = (t) => CATS.find((c) => String(c.type_id) === String(t));

const UA_LIST = [
  process.env.MISSAV_UA || '',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
].filter(Boolean);

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/',
    'Accept-Language': 'zh-TW,zh;q=0.9,zh-CN;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

// genre 字段直接存列表页 path（见 CATS）；query 走 /search/<关键词>（路径式）
function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  void sort;
  let url;
  if (query) url = `${base}/search/${encodeURIComponent(query)}`;
  else if (genre) url = `${base}${genre.startsWith('/') ? genre : '/' + genre}`;
  else url = `${base}/new`;
  if (pg > 1) url += (url.includes('?') ? '&' : '?') + `page=${pg}`;
  return url;
}

// 非视频 slug 黑名单（导航/聚合页）：命中则跳过。视频 slug 形如 dldss-572，必含数字。
const NAV_SLUGS = new Set(
  'new release uncensored-leak chinese-subtitle today-hot weekly-hot monthly-hot vr fc2 heyzo tokyohot 1pondo caribbeancom caribbeancompr 10musume pacopacomama gachinco xxxav marriedslash naughty4610 naughty0930 madou twav furuke siro luxu gana ara scute maan genres actresses makers series labels actors directors vip saved playlists history klive clive articles contact ads terms upload search ranking'.split(
    ' '
  )
);

function normVid(href) {
  if (!href || !href.startsWith('/')) return '';
  const m = href.split('#')[0].split('?')[0].match(/^\/(?:dm\d+\/)?([a-z0-9][a-z0-9\-_]*)\/?$/i);
  if (!m) return '';
  const slug = m[1].toLowerCase();
  if (NAV_SLUGS.has(slug)) return '';
  if (!/[0-9]/.test(slug)) return ''; // 番号必含数字，过滤剩余导航词
  return slug;
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function parseList(html) {
  const $ = cheerio.load(html);
  const videos = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const vid = normVid($(a).attr('href') || '');
    if (!vid || seen.has(vid)) return;
    const inner = $(a);
    let pic = '';
    inner.find('img').each((__, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src') || '';
      if (!src || /icon|avatar|logo|flag/i.test(src)) return;
      if (!pic) pic = src.startsWith('//') ? 'https:' + src : src;
    });
    let title = clean(inner.find('img').first().attr('alt') || '');
    if (!title) title = clean(inner.text()).slice(0, 120);
    if (!title) return;
    seen.add(vid);
    videos.push({ vid, title, pic: pic || '' });
  });
  return videos;
}

function parsePageCount(html, pg) {
  let max = pg;
  const pats = [/[?&]page=(\d+)/g, /\/page\/(\d+)/g];
  for (const re of pats) {
    let m;
    while ((m = re.exec(html))) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max && n < 10000) max = n;
    }
  }
  return max;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SURRIT_URL_RE = /https?:\/\/[^\s"'<>]*surrit[^\s"'<>]*?\.m3u8[^\s"'<>]*/i;

// 从详情页 HTML 提取 surrit m3u8：
// 1) 字面 surrit m3u8 直链；2) 含 surrit 的脚本块内 UUID → 拼 playlist；
// 3) 播放器相关脚本内 UUID → 拼 playlist（广告位 blob UUID 在 missav.ai 域下，不含 surrit 上下文，天然排除）
function extractM3u8(html) {
  const lit = html.match(SURRIT_URL_RE);
  if (lit) return lit[0].replace(/[\\,;)\]]+$/, '');
  const $ = cheerio.load(html);
  const scripts = [];
  $('script').each((_, s) => {
    const t = $(s).html() || '';
    if (t) scripts.push(t);
  });
  const withSurrit = scripts.filter((t) => /surrit/i.test(t));
  for (const t of withSurrit) {
    const u = (t.match(UUID_RE) || [])[0];
    if (u) return `https://surrit.com/${u.toLowerCase()}/playlist.m3u8`;
  }
  const playerish = scripts.filter((t) => /playlist\.m3u8|player|source\s*[:=]|1080p|720p/i.test(t));
  for (const t of playerish) {
    const u = (t.match(UUID_RE) || [])[0];
    if (u) return `https://surrit.com/${u.toLowerCase()}/playlist.m3u8`;
  }
  return '';
}

function parseDetail(html, vid) {
  const $ = cheerio.load(html);
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean(og('title').replace(/\s*[-–|]\s*(MissAV|MISS\s*AV).*$/i, ''));
  if (!title) title = clean($('h1').first().text()).slice(0, 120) || `missav ${vid}`;
  const picRaw = og('image') || '';
  const desc = clean(og('description'));

  let actor = '';
  $('a[href*="/actresses/"]').each((_, a) => {
    if (actor) return;
    const t = clean($(a).text());
    if (t && t.length <= 30) actor = t;
  });
  const tagLinks = [];
  $('a[href*="/genres/"]').each((_, a) => {
    const t = clean($(a).text());
    if (t && t.length <= 20 && !tagLinks.includes(t)) tagLinks.push(t);
  });
  const genreName = tagLinks[0] || '';

  const m3u8 = extractM3u8(html);
  const sources = m3u8 ? [{ size: 0, src: m3u8 }] : [];
  // 直通站：episodes 自带 url，框架原样拼进 vod_play_url（不走 /h/ 转封装）
  const episodes = [{ name: '正片', vid: String(vid), ...(m3u8 ? { url: m3u8 } : {}) }];

  return { title, pic: picRaw, desc, actor, genreName, sources, episodes, tags: tagLinks.slice(0, 30) };
}

module.exports = {
  key: 'missav',
  displayName: 'MissAV',
  baseEnv: 'MISSAV_BASE',
  defaultBase: 'https://missav.ai',
  publicBaseEnv: 'PUBLIC_BASE_MISSAV',
  uaEnv: 'MISSAV_UA',
  passthrough: true, // 原生 m3u8 直传：列表不拼 /h/，详情用自带 url
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  parseList,
  parsePageCount,
  parseDetail,
  extractM3u8,
};
