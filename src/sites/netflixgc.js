'use strict';

/**
 * netflixgc 奈飞工厂 (https://www.netflixgc.com) 适配器。
 * 标准 AppleCMS 站（原生 /api.php/provide/vod 已关闭，只能 HTML/JSON 刮削）：
 *   分类列表走站内 AJAX JSON 接口 POST /index.php/ds_api/vod
 *     （type=1电影/2连续剧/3漫剧/23综艺/24纪录片/57体育，by=time/hits/score，每页 40 条，
 *      返回 {code, pagecount, total, list:[{vod_id, vod_name, vod_pic}]}, GET 被反爬只吐 JS 桩，必须 POST）
 *   搜索走服务端渲染页 /vodsearch/<wd>----------<pg>---.html（.search-list 卡片，.page-tip 拿总页数）
 *   详情 /voddetail/<id>.html：标题/封面/简介/演职员 + 多线路选集盒（.anthology-list-box），
 *     默认走 sid=1 那盒（站内 data-link 默认也是 /vodplay/<id>-1-1.html），其余线路丢弃
 *   播放 /vodplay/<id>-<sid>-<nid>.html：内联 player_aaaa JSON（encrypt=2 即 base64(escape(url))），解出原生 m3u8
 *
 * 选集 vid 取 "id-sid-nid" 形式（框架 handleDetail/detailUrl 透传）：
 *   detailUrl 按 vid 形态分流（纯数字→详情页，id-sid-nid→播放页），
 *   parseDetail 双模：详情页只做元数据+选集清单（无 m3u8，不多抓 N 个播放页），
 *   播放页解 player_aaaa 得 m3u8。
 * 详情经 expandDetailUrl 顺带抓默认集（sid=1,nid=1）播放页，给 /play?v=<裸id> 留一条活路（302 到第 1 集）。
 * 播放由框架 /h/<site>/<id-sid-nid>/index.m3u8 懒解析：resolveMp4 拿到 m3u8 后
 *   redirectM3u8 直接 302（自带 Referer 防盗链的源走前端 proxyMode 中转，不要 ffmpeg 转封装）。
 * 环境变量：NETFLIXGC_BASE（默认 https://www.netflixgc.com）
 */

const cheerio = require('cheerio');

const CATS = [
  { type_id: 1, type_name: '电影', genre: '1' },
  { type_id: 2, type_name: '连续剧', genre: '2' },
  { type_id: 3, type_name: '漫剧', genre: '3' },
  { type_id: 23, type_name: '综艺', genre: '23' },
  { type_id: 24, type_name: '纪录片', genre: '24' },
  { type_id: 57, type_name: '体育', genre: '57' },
  // 首页榜单（服务端渲染整页，按 h4 分节提取；无翻页，每榜约 8 条）
  { type_id: 101, type_name: '热播榜', genre: 'board:热播榜', group: '榜单' },
  { type_id: 102, type_name: '热搜榜', genre: 'board:热搜榜', group: '榜单' },
  { type_id: 103, type_name: '经典榜', genre: 'board:经典榜', group: '榜单' },
  { type_id: 104, type_name: '冷门佳作榜', genre: 'board:冷门佳作榜', group: '榜单' },
  { type_id: 105, type_name: '近期开播新剧', genre: 'board:近期开播新剧', group: '榜单' },
  { type_id: 106, type_name: '最新热播电影', genre: 'board:最新热播电影', group: '榜单' },
];

function catById(t) {
  return CATS.find((c) => String(c.type_id) === String(t));
}

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function headersFor(ua, base) {
  return {
    'User-Agent': ua,
    Referer: base + '/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// 分类走 POST JSON（框架 fetchListHtml 识别 {url, post} 即改 POST 表单提交）；
// 搜索走 GET 服务端渲染页。 by 透传 sort（time/hits/score），非法回 time。
// 榜单走首页 GET（query 仅做缓存区分，站内忽略），按 h4 分节提取
function boardNameOf(req) {
  const s = typeof req === 'string' ? req : (req && req.url) || '';
  const m = String(s).match(/[?&]board=([^&]*)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return '';
  }
}

function buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
  const page = Math.max(1, parseInt(pg, 10) || 1);
  if (query) return `${base}/vodsearch/${encodeURIComponent(query)}----------${page}---.html`;
  if (String(genre).startsWith('board:')) {
    return `${base}/?board=${encodeURIComponent(String(genre).slice(6))}`;
  }
  const type = /^\d+$/.test(String(genre)) ? String(genre) : '1';
  const by = /^(time|hits|score)$/.test(String(sort)) ? String(sort) : 'time';
  return {
    url: `${base}/index.php/ds_api/vod`,
    post: `type=${encodeURIComponent(type)}&page=${page}&by=${by}`,
  };
}

// 首页榜单分节：h4 标题（标题常带 emoji 后缀，用 startsWith 认）→ 所属 .box-width → 卡片
function parseBoard($, board) {
  const h = $('h4')
    .filter((_, el) => clean($(el).text()).startsWith(board))
    .first();
  if (!h.length) return [];
  const sec = h.closest('div.box-width');
  const scope = sec.length ? sec : $.root();
  const videos = [];
  const seen = new Set();
  scope.find('a.public-list-exp[href^="/voddetail/"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/voddetail\/(\d+)\.html/);
    if (!m || seen.has(m[1])) return;
    const title = clean($(a).attr('title')) || clean($(a).find('img').first().attr('alt'));
    if (!title) return;
    const img = $(a).find('img').first();
    let pic = img.attr('data-src') || img.attr('src') || '';
    if (/^data:image/i.test(pic)) pic = '';
    seen.add(m[1]);
    videos.push({ vid: m[1], title, pic });
  });
  return videos;
}

// JSON（分类）/ 搜索页 HTML / 首页榜单 HTML 三模：
// req 是 buildSearchUrl 的返回值（字符串 URL 或 {url, post}），榜单分支靠它认分节
function parseList(text, req) {
  const t = String(text || '');
  if (t.trimStart().startsWith('{')) {
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      return [];
    }
    return ((o && o.list) || [])
      .map((v) => ({
        vid: String(v.vod_id || ''),
        title: clean(v.vod_name),
        pic: String(v.vod_pic || v.vod_pic_thumb || ''),
      }))
      .filter((v) => v.vid && v.title);
  }
  const $ = cheerio.load(t);
  const board = boardNameOf(req);
  if (board) return parseBoard($, board);
  const videos = [];
  const seen = new Set();
  $('.search-list').each((_, box) => {
    const a = $(box).find('a[href^="/voddetail/"]').first();
    const m = (a.attr('href') || '').match(/\/voddetail\/(\d+)\.html/);
    if (!m || seen.has(m[1])) return;
    const title = clean(a.find('h3').first().text() || a.attr('title'));
    if (!title) return;
    const img = $(box).find('.detail-pic img').first();
    let pic = img.attr('data-src') || img.attr('src') || '';
    if (/^data:image/i.test(pic)) pic = '';
    seen.add(m[1]);
    videos.push({ vid: m[1], title, pic });
  });
  return videos;
}

function parsePageCount(text, pg, req) {
  if (boardNameOf(req)) return Math.max(1, parseInt(pg, 10) || 1); // 榜单单页
  const t = String(text || '');
  if (t.trimStart().startsWith('{')) {
    try {
      const n = parseInt(JSON.parse(t).pagecount, 10);
      if (!isNaN(n) && n >= 1) return Math.min(n, 5000);
    } catch {}
    return pg;
  }
  const m = t.match(/当前\s*\d+\s*\/\s*(\d+)\s*页/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n >= 1) return Math.min(n, 5000);
  }
  return pg;
}

// 纯数字→详情页；id-sid-nid→播放页（选集懒解析就靠它）
function detailUrl(vid, base) {
  const v = String(vid);
  if (/^\d+-\d+-\d+$/.test(v)) return `${base}/vodplay/${v}.html`;
  return `${base}/voddetail/${encodeURIComponent(v)}.html`;
}

// 裸 id 详情顺带抓默认集（data-link，无则 sid=1 nid=1），给 /play?v=<裸id> 留活路；
// 选集 vid 进来已是播放页，不再二跳
function expandDetailUrl(metaHtml, vid, base) {
  if (/^\d+-\d+-\d+$/.test(String(vid))) return null;
  const m = String(metaHtml || '').match(/data-link="(\/vodplay\/\d+-\d+-\d+\.html)"/);
  if (m) {
    try {
      return new URL(m[1], base).href;
    } catch {}
  }
  return `${base}/vodplay/${encodeURIComponent(String(vid))}-1-1.html`;
}

// player_aaaa 解密：encrypt=2 是 base64(escape(url))，1 是 escape(url)，0 是明文
function decryptPlayerUrl(u, encrypt) {
  let s = String(u || '').replace(/\\\//g, '/').trim();
  if (!s) return '';
  if (Number(encrypt) === 2) {
    try {
      s = Buffer.from(s, 'base64').toString('utf8');
    } catch {}
  }
  if (Number(encrypt) === 1 || Number(encrypt) === 2) {
    try {
      s = unescape(s);
    } catch {}
  }
  s = s.trim().replace(/^['"]+|['"]+$/g, '');
  return /^https?:\/\//i.test(s) ? s : '';
}

function parseDetail(html, vid, playHtml) {
  const v = String(vid);
  // —— 播放页模式（选集 vid=id-sid-nid）：提 player_aaaa 直链 ——
  if (/^\d+-\d+-\d+$/.test(v)) {
    const src = String(playHtml !== undefined ? playHtml : html);
    const m = src.match(/player_aaaa\s*=\s*(\{.*\})\s*<\/script>/s) || src.match(/player_aaaa\s*=\s*(\{.*\})/s);
    if (m) {
      try {
        const o = JSON.parse(m[1]);
        const url = decryptPlayerUrl(o.url, o.encrypt);
        if (url) {
          return {
            title: clean((o.vod_data && o.vod_data.vod_name) || `netflixgc ${v}`),
            pic: '',
            desc: '',
            actor: '',
            genreName: '',
            sources: [{ src: url }],
            episodes: [{ name: '正片', url, vid: v }],
            tags: [],
          };
        }
      } catch {}
    }
    return { title: `netflixgc ${v}`, pic: '', desc: '', actor: '', genreName: '', sources: [], episodes: [], tags: [] };
  }
  // —— 详情页模式：元数据 + sid=1 选集盒（无 m3u8，播放时懒解析） ——
  const $ = cheerio.load(String(html || ''));
  let title = clean($('.slide-info-title').first().text()).slice(0, 120);
  if (!title) title = clean(($('title').first().text() || '').split(/[-–|]/)[0]).slice(0, 120);
  if (!title) title = `netflixgc ${v}`;
  const img = $('.detail-pic img').first();
  let pic = img.attr('data-src') || img.attr('src') || '';
  if (/^data:image/i.test(pic)) pic = '';
  const desc = clean($('#height_limit').text() || $('.vod-tag').first().text());
  let actor = '';
  let director = '';
  let genreName = '';
  $('.slide-info').each((_, el) => {
    const label = clean($(el).find('strong').first().text());
    const names = $(el)
      .find('a')
      .map((_, a) => clean($(a).text()))
      .get()
      .filter((s) => s && s.length <= 20);
    if (/演员/.test(label)) actor = names.join(',');
    else if (/导演/.test(label)) director = names.join(',');
    else if (/类型|类别/.test(label) && !genreName) genreName = names[0] || '';
  });
  const tags = $('.vod-tag a')
    .map((_, a) => clean($(a).text()).replace(/^#+/, ''))
    .get()
    .filter((s) => s && s.length <= 30)
    .slice(0, 20);
  // 选集：优先 sid=1 那盒（站内默认线路），没有则回退首个含本 id 链接的盒子
  let epLinks = [];
  $('.anthology-list-box').each((_, box) => {
    const links = $(box)
      .find('a[href*="/vodplay/"]')
      .map((_, a) => ({ href: $(a).attr('href') || '', name: clean($(a).text()) }))
      .get()
      .filter((l) => new RegExp(`/vodplay/${v}-\\d+-\\d+\\.html`).test(l.href));
    if (!links.length) return;
    if (!epLinks.length) epLinks = links; // 回退：首盒
    if (/\/vodplay\/\d+-1-\d+\.html/.test(links[0].href)) {
      epLinks = links; // 命中默认线路，锁定
      return false;
    }
  });
  const episodes = epLinks
    .map((l) => {
      const m = l.href.match(/\/vodplay\/(\d+-\d+-\d+)\.html/);
      if (!m) return null;
      return { name: l.name || m[1], vid: m[1] };
    })
    .filter(Boolean);
  // 详情二跳的默认集直链（expandDetailUrl 抓的 ep1 播放页）：给 /play?v=<裸id> 用
  let sources = [];
  if (playHtml && playHtml !== html) {
    const pm = String(playHtml).match(/player_aaaa\s*=\s*(\{.*\})/s);
    if (pm) {
      try {
        const o = JSON.parse(pm[1]);
        const url = decryptPlayerUrl(o.url, o.encrypt);
        if (url) sources = [{ src: url }];
      } catch {}
    }
  }
  return {
    title,
    pic,
    desc,
    actor: [director, actor].filter(Boolean).join(' / ') || actor,
    genreName,
    sources,
    episodes,
    tags,
  };
}

module.exports = {
  key: 'netflixgc',
  displayName: '奈飞工厂',
  baseEnv: 'NETFLIXGC_BASE',
  defaultBase: 'https://www.netflixgc.com',
  publicBaseEnv: 'PUBLIC_BASE_NETFLIXGC',
  redirectM3u8: true, // /h/ 懒解析到原生 m3u8 后直接 302，不走 ffmpeg 转封装
  noCachePlayHtml: true, // 二跳默认集播放页（短效直链）每次现抓
  CATS,
  catById,
  UA_LIST,
  headersFor,
  buildSearchUrl,
  detailUrl,
  expandDetailUrl,
  decryptPlayerUrl,
  parseList,
  parsePageCount,
  parseDetail,
};
