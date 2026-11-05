'use strict';

/**
 * hanime1.me 站点适配器（从 hanime1-maccms/server.js 原样迁移，行为零变化）。
 * 环境变量：HANIME_BASE / HANIME_UA / PUBLIC_BASE_HANIME1（或全局 PUBLIC_BASE）
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '最新里番', genre: '裏番', sort: '最新上市', group: '分类' },
  { type_id: 2, type_name: '最新上市', genre: '', sort: '最新上市', group: '分类' },
  { type_id: 3, type_name: '最新上傳', genre: '', sort: '最新上傳', group: '分类' },
  { type_id: 4, type_name: '裏番', genre: '裏番', sort: '', group: '分类' },
  { type_id: 5, type_name: '泡麵番', genre: '泡麵番', sort: '', group: '分类' },
  { type_id: 6, type_name: 'Motion Anime', genre: 'Motion Anime', sort: '', group: '分类' },
  { type_id: 7, type_name: '3DCG', genre: '3DCG', sort: '', group: '分类' },
  { type_id: 8, type_name: '2.5D', genre: '2.5D', sort: '', group: '分类' },
  { type_id: 9, type_name: '2D動畫', genre: '2D動畫', sort: '', group: '分类' },
  { type_id: 10, type_name: 'AI生成', genre: 'AI生成', sort: '', group: '分类' },
  { type_id: 11, type_name: 'MMD', genre: 'MMD', sort: '', group: '分类' },
  { type_id: 12, type_name: 'Cosplay', genre: 'Cosplay', sort: '', group: '分类' },
  { type_id: 13, type_name: '新番預告', genre: '新番預告', sort: '', group: '分类' },
];

const catById = (t) => CATS.find((c) => String(c.type_id) === String(t));

const UA_LIST = [
  process.env.HANIME_UA || '',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
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

// ---- 列表解析 (兼容首页 cards + 搜索页 horizontal-card) ----
function parseList(html) {
  const $ = cheerio.load(html);
  const videos = [];
  const seen = new Set();
  const push = (vid, title, pic) => {
    if (!vid || seen.has(vid)) return;
    title = clean(title);
    if (!title) return;
    if (pic && pic.startsWith('//')) pic = 'https:' + pic;
    seen.add(vid);
    videos.push({ vid, title, pic: pic || '' });
  };
  // A. 首页/分类: a > .home-rows-videos-title + img
  // 选集标题: 优先取 .video-item-container[title] 全称 (搜索页 .title div 是缩写)
  $('a[href*="/watch?v="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (href.includes('erodalabs')) return;
    const m = href.match(/[?&]v=(\d+)/);
    if (!m) return;
    const inner = $(a);
    // 跳过详情页播放列表/相关推荐里的 thumb 链接 (文字是时长+点赞, 无标题)
    if (inner.closest('#playlist-scroll, #video-playlist-wrapper, #related-videos').length) return;
    const card = inner.closest('.video-item-container');
    let title = card.length ? clean(card.attr('title') || '') : '';
    if (!title) title = clean(inner.find('.home-rows-videos-title').first().text());
    if (!title && card.length) title = clean(card.find('.title').first().text());
    if (!title) title = clean(inner.find('.video-title').first().text());
    if (!title) title = clean(inner.attr('title') || '');
    if (!title) title = clean(inner.find('img').first().attr('alt') || '');
    if (!title) return;
    let pic = '';
    inner.find('img').each((__, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
      if (!src || /icon|avatar|erolabs|arrow_down|search_input/i.test(src)) return;
      if (!pic) pic = src;
    });
    push(m[1], title, pic);
  });
  // B. 搜索页兜底: .video-item-container[title] (a.video-link 可能被 A 漏掉时)
  if (!videos.length) {
    $('.video-item-container').each((_, c) => {
      const link = $(c).find('a.video-link[href*="watch?v="]').first();
      const href = link.attr('href') || '';
      const m = href.match(/[?&]v=(\d+)/);
      if (!m) return;
      const title = clean($(c).attr('title') || '') || clean($(c).find('.title').first().text());
      const pic = link.find('img.main-thumb').attr('src') || $(c).find('img.main-thumb').attr('src') || '';
      push(m[1], title, pic);
    });
  }
  return videos;
}

function parsePageCount(html, pg) {
  const $ = cheerio.load(html);
  let max = pg;
  $('ul.pagination a.page-link, .pagination a').each((_, a) => {
    const t = clean($(a).text());
    const n = parseInt(t, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  // 兜底: 文案里找 "?page=72" 这类最大页
  const m = html.match(/page=(\d+)/g);
  if (m) {
    for (const s of m) {
      const n = parseInt(s.split('=')[1], 10);
      if (!isNaN(n) && n > max && n < 10000) max = n;
    }
  }
  return max;
}

function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  const p = new URLSearchParams();
  if (genre) p.set('genre', genre);
  if (sort) p.set('sort', sort);
  if (query) p.set('query', query);
  else p.set('query', '');
  p.set('page', String(pg));
  return `${base}/search?${p.toString()}`;
}

// ---- 详情解析 ----
function parseDetail(html, vid) {
  const $ = cheerio.load(html);
  const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content') || '';
  let title = clean(og('title').replace(/\s*-\s*Hanime1\.me\s*$/i, ''));
  const picRaw = og('image');
  const desc = clean(og('description'));
  if (!title) {
    title =
      clean($('#video-playlist-wrapper h4').first().text()) ||
      clean($('h1').first().text()) ||
      `hanime1 ${vid}`;
  }
  // 作者 + 真实分类: #video-artist-name, genre 链接
  let actor = clean($('#video-artist-name').first().text());
  if (!actor) {
    const userLink = $('#video-playlist-wrapper a[href*="/user/"]').first();
    if (userLink.length) actor = clean(userLink.text());
  }
  let genreName = '';
  const genreLink = $('#video-artist-name').parent().parent().find('a[href*="genre="]').first();
  if (genreLink.length) genreName = clean(genreLink.text());
  if (!genreName) {
    const g2 = $('a[href*="search?genre="]').first();
    if (g2.length) genreName = clean(g2.text());
  }

  // 直链 source
  const sources = [];
  $('source[size][src]').each((_, s) => {
    const src = $(s).attr('src');
    const size = parseInt($(s).attr('size'), 10) || 0;
    if (src && /^https?:\/\//.test(src)) sources.push({ size, src });
  });
  // 兜底: 内联 json / 裸 mp4
  if (!sources.length) {
    const m = html.match(/https?:\/\/[^\s'"]+?\.mp4[^\s'"]*/);
    if (m) sources.push({ size: 0, src: m[0] });
  }
  sources.sort((a, b) => b.size - a.size);

  // 选集: #playlist-scroll .playlist-hover-wrap (标题取 .video-title a, 避免 thumb 链接里的时长/点赞污染)
  const eps = [];
  const seen = new Set();
  $('#playlist-scroll .playlist-hover-wrap').each((_, w) => {
    const wrap = $(w);
    const href = wrap.attr('data-href') || wrap.find('a[href*="watch?v="]').first().attr('href') || '';
    const m = href.match(/[?&]v=(\d+)/);
    if (!m) return;
    const ev = m[1];
    if (seen.has(ev)) return;
    let name = clean(wrap.find('.video-title a').first().text());
    if (!name) name = clean(wrap.find('.video-title').first().text());
    if (!name) name = `第${eps.length + 1}集`;
    name = name.replace(/[#$\r\n]+/g, ' ').slice(0, 80) || `第${eps.length + 1}集`;
    seen.add(ev);
    eps.push({ name, vid: ev });
  });
  // 兜底: 非系列页没有 playlist 时只返回当前这一集
  if (!eps.length) eps.push({ name: title || '正片', vid: String(vid) });
  // 把当前请求的 vid 置顶为默认播放 (TVBox 同款修复)
  const idx = eps.findIndex((e) => e.vid === String(vid));
  if (idx > 0) {
    const [cur] = eps.splice(idx, 1);
    eps.unshift(cur);
  } else if (idx === -1) {
    eps.unshift({ name: title || '正片', vid: String(vid) });
  }
  // tags: .single-video-tag a (文本含 # 前缀与 (n) 计数, 需清洗; 过滤 add/remove 按钮)
  const tags = [];
  $('.single-video-tag a').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href || !href.includes('/search?')) return; // add/remove 按钮无 href
    const t = clean($(a).text()).replace(/^#\s*/, '').replace(/\s*\(\d+\)\s*$/, '').replace(/[#$,]+/g, '');
    if (t && t.length <= 20 && !tags.includes(t)) tags.push(t);
  });

  return { title, pic: picRaw, desc, actor, genreName, sources, episodes: eps, tags: tags.slice(0, 30) };
}

// 站内 genre 标签库：从首页与搜索页抓 `search?genre=` 链接并进来（24 小时缓存），
// 按真实站点类别同步。type_id 直接用 genre 名（框架层全走 String 比对）。
// 注意：部分网络（如本地直连）会被站方 CF 拦截，全灭时静默回退内置 13 个，
// 线上 VPS 出口一般能过。与内置重复 genre 的跳过。
let navCatsLoadedAt = 0;
const NAV_TTL_MS = 24 * 3600 * 1000;

async function ensureNavCats(base, fetchFn) {
  const now = Date.now();
  if (now - navCatsLoadedAt < NAV_TTL_MS && CATS.length > 13) return;
  try {
    const origin = (base || 'https://hanime1.me').replace(/\/$/, '');
    const haveGenres = new Set(CATS.map((c) => c.genre));
    const found = new Map();
    for (const url of [origin + '/', origin + '/search?query=']) {
      let html = '';
      for (const ua of UA_LIST) {
        try {
          const res = await fetchFn(url, { headers: headersFor(ua, origin) });
          if (res.status === 403 || res.status === 503) continue;
          if (!res.ok) break;
          html = await res.text();
          break;
        } catch {
          /* 换 UA */
        }
      }
      if (!html) continue;
      const $ = cheerio.load(html);
      $('a[href*="genre="]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/genre=([^"&]+)/i);
        if (!m) return;
        let genre = '';
        try {
          genre = decodeURIComponent(m[1]);
        } catch {
          return;
        }
        const name = clean($(a).text()) || genre;
        if (!genre || genre.length > 20 || !name || name.length > 20) return;
        if (!found.has(genre)) found.set(genre, name);
      });
    }
    for (const [genre, name] of found) {
      if (haveGenres.has(genre)) continue;
      haveGenres.add(genre);
      CATS.push({ type_id: genre, type_name: name, genre, sort: '', group: '标签' });
    }
    navCatsLoadedAt = now;
  } catch {
    // 导航拉取/解析失败不影响列表：继续用内置 13 个
  }
}

module.exports = {
  key: 'hanime1',
  displayName: 'Hanime1',
  baseEnv: 'HANIME_BASE',
  defaultBase: 'https://hanime1.me',
  publicBaseEnv: 'PUBLIC_BASE_HANIME1',
  uaEnv: 'HANIME_UA',
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  ensureNavCats,
  parseList,
  parsePageCount,
  parseDetail,
};
