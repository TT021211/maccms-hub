'use strict';

/**
 * maccms-hub 通用核心：MacCMS V10 provide/vod 采集网关 + HLS 播放链路。
 * 站点差异全部下沉到 src/sites/<key>.js，本文件只做：
 * 路由 / 缓存 / MacCMS 信封 / /play 302 / ffmpeg HLS 转封装。
 *
 * 地址形态（<site> = 站点 key，如 hanime1）：
 *   列表/搜索/详情: /<site>/api.php/provide/vod/?ac=list&t=1&pg=1 ...
 *   兼容老地址（无前缀 → DEFAULT_SITE，默认 hanime1，老 MoonTV 配置不用改）：
 *                     /api.php/provide/vod/?ac=list&t=4&pg=1
 *   直链: /play?site=<site>&v=VID        （兼容 /play?v=VID → 默认站）
 *   HLS:  /h/<site>/<vid>/index.m3u8     （兼容 /h/<vid>/index.m3u8 → 默认站）
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3001);
const CACHE_TTL = Number(process.env.CACHE_TTL || 86400) * 1000;
const HLS_DIR = process.env.HLS_DIR || '/tmp/hls';
const HLS_MAX_GB = Number(process.env.HLS_MAX_GB || 8);
const DEFAULT_SITE = process.env.DEFAULT_SITE || 'hanime1';

// ---- 加载站点适配器（_template.js 除外） ----
const sitesDir = path.join(__dirname, 'sites');
const sites = new Map();
for (const f of fs.readdirSync(sitesDir)) {
  if (!f.endsWith('.js') || f.startsWith('_')) continue;
  const def = require(path.join(sitesDir, f));
  if (!def || !def.key) continue;
  const key = String(def.key).toLowerCase();
  const base = (process.env[def.baseEnv || ''] || def.defaultBase || '').replace(/\/$/, '');
  const publicBase = (
    process.env[def.publicBaseEnv || ''] ||
    process.env.PUBLIC_BASE ||
    ''
  ).replace(/\/$/, '');
  sites.set(key, { def, key, base, publicBase });
}
if (!sites.has(DEFAULT_SITE)) {
  console.warn(`[hub] DEFAULT_SITE=${DEFAULT_SITE} 不存在，可用站: ${[...sites.keys()].join(',') || '(无)'}`);
}

function siteOf(name) {
  const s = sites.get(String(name || '').toLowerCase());
  return s || null;
}

// ScraperAPI 中转（给 CF 站用，如 missav）：render=true 是必须的，普通模式会被拒。
// 结果按原始 URL 缓存，credits 只花在缓存未命中时。
function buildRelayUrl(url) {
  const key = process.env.SCRAPERAPI_KEY || '';
  if (!key) return null;
  return `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=true`;
}

function fmtTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

// ---- 简单内存缓存 ----
const cache = new Map(); // key -> { exp, data }
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) {
    cache.delete(key);
    return null;
  }
  return e.data;
}
function cacheSet(key, data, ttl = CACHE_TTL) {
  if (cache.size > 2000) cache.clear();
  cache.set(key, { exp: Date.now() + ttl, data });
}

// ScraperAPI 试用 key 并发低，多路并发 render 会被排队超时；网关侧串行化（FIFO 排队），宁可慢不能挂
const RELAY_MAX_CONCURRENT = Number(process.env.RELAY_MAX_CONCURRENT || 3);
let relayRunning = 0;
const relayQueue = [];
function relayAcquire() {
  return new Promise((resolve) => {
    if (relayRunning < RELAY_MAX_CONCURRENT) {
      relayRunning++;
      resolve();
    } else {
      console.log(`[relay] 并发已满，排队 depth=${relayQueue.length + 1}`);
      relayQueue.push(resolve);
    }
  });
}
function relayRelease() {
  const next = relayQueue.shift();
  if (next) next();
  else relayRunning--;
}

async function fetchHtml(site, url) {
  // skipHtmlCache：页面内嵌短效 token（如 kinostream 的 m3u8 token 约 4 小时过期），
  // 缓存 HTML 等于缓存过期 token，必须每次现抓
  const noCache = !!site.def.skipHtmlCache;
  if (!noCache) {
    const hit = cacheGet('html:' + url);
    if (hit) return hit;
  }
  // 中转模式（missav 这类 CF 站）：走 ScraperAPI render，结果按原 URL 缓存
  if (site.def.useRelay) {
    const relay = buildRelayUrl(url);
    if (!relay) throw new Error('relay enabled but SCRAPERAPI_KEY is missing');
    await relayAcquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    try {
      console.log(`[relay][${site.key}] ${url.slice(0, 120)}`);
      const res = await fetch(relay, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`relay http ${res.status} for ${url}`);
      const text = await res.text();
      if (!noCache) cacheSet('html:' + url, text);
      return text;
    } finally {
      clearTimeout(timer);
      relayRelease();
    }
  }
  const uaList = (site.def.UA_LIST || []).filter(Boolean);
  const uas = (uaList.length ? uaList : ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36']).slice(0, 2);
  let lastErr = null;
  for (const ua of uas) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, { headers: site.def.headersFor(ua, site.base), signal: ctrl.signal });
      if (res.status === 403 || res.status === 503) {
        lastErr = new Error(`upstream http ${res.status} for ${url}`);
        continue; // 换 UA 重试 (CF 指纹拦截)
      }
      if (!res.ok) throw new Error(`upstream http ${res.status} for ${url}`);
      const text = await res.text();
      if (!noCache) cacheSet('html:' + url, text);
      return text;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed for ' + url);
}

function ffExec(args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error('ffmpeg: ' + (stderr || err.message).slice(0, 500)));
      else resolve(stdout);
    });
  });
}

function hlsVidDir(site, vid) {
  // 默认站沿用老布局 /tmp/hls/<vid>（已缓存的切片不用重切）；其他站隔离到子目录防 vid 撞车
  const safe = String(vid).replace(/[^0-9]/g, '') || 'x';
  if (site.key === DEFAULT_SITE) return path.join(HLS_DIR, safe);
  return path.join(HLS_DIR, site.key, safe);
}

// 总量超过上限时删最旧的整集目录
function hlsEvict() {
  try {
    fs.mkdirSync(HLS_DIR, { recursive: true });
    const collect = (root) =>
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const p = path.join(root, d.name);
          let size = 0;
          let mtime = 0;
          let files = [];
          try {
            files = fs.readdirSync(p);
          } catch {
            return null;
          }
          for (const f of files) {
            try {
              const st = fs.statSync(path.join(p, f));
              size += st.size;
              mtime = Math.max(mtime, st.mtimeMs);
            } catch {}
          }
          return { p, size, mtime };
        })
        .filter(Boolean);
    let dirs = collect(HLS_DIR);
    // 二级目录（按站隔离时）
    for (const d of [...dirs]) {
      try {
        if (fs.statSync(d.p).isDirectory()) dirs = dirs.concat(collect(d.p));
      } catch {}
    }
    dirs.sort((a, b) => a.mtime - b.mtime);
    let total = dirs.reduce((s, d) => s + d.size, 0);
    const cap = HLS_MAX_GB * 1024 * 1024 * 1024;
    for (const d of dirs) {
      if (total <= cap) break;
      try {
        fs.rmSync(d.p, { recursive: true, force: true });
        total -= d.size;
      } catch {}
    }
  } catch {}
}

// 详情页地址：默认 /watch?v=（hanime 系），适配器可用 detailUrl(vid, base) 覆盖
// （missav 的 /<slug>、aqdlt 的 /videos/play/<vid>.html、hohoj 的 /video?id=<vid>）
function defaultDetailUrl(vid, base) {
  return `${base}/watch?v=${encodeURIComponent(vid)}`;
}

function detailPageUrl(site, vid) {
  const fn = site.def.detailUrl || defaultDetailUrl;
  return fn(String(vid), site.base);
}

// 有些站详情页只是个壳（标题/封面），真实播放地址在内嵌 iframe/子页里
// （如 hohoj 的 /embed?id=）。适配器可用 expandDetailUrl(metaHtml, vid, base)
// 返回子页地址，框架会接着抓子页；parseDetail(html, vid, playHtml) 拿子页提 m3u8。
async function fetchPlayableHtml(site, vid) {
  const metaUrl = detailPageUrl(site, vid);
  const metaHtml = await fetchHtml(site, metaUrl);
  if (typeof site.def.expandDetailUrl === 'function') {
    try {
      const embedUrl = site.def.expandDetailUrl(metaHtml, vid, site.base);
      if (embedUrl && embedUrl !== metaUrl) {
        const playHtml = await fetchHtml(site, embedUrl);
        return { metaHtml, playHtml };
      }
    } catch (e) {
      console.warn(`[expand][${site.key}] ${vid} 子页抓取失败，用详情页兜底: ${(e && e.message) || e}`);
    }
  }
  return { metaHtml, playHtml: metaHtml };
}

async function resolveMp4(site, vid) {
  cache.delete('html:' + detailPageUrl(site, vid));
  const { metaHtml, playHtml } = await fetchPlayableHtml(site, vid);
  const d = site.def.parseDetail(metaHtml, String(vid), playHtml);
  if (!d.sources.length) throw new Error('no playable source');
  return d.sources[0].src;
}

const hlsJobs = new Map(); // `${site}:${vid}` -> Promise
function ensureHls(site, vid) {
  const dir = hlsVidDir(site, vid);
  const playlist = path.join(dir, 'index.m3u8');
  const doneFile = path.join(dir, '.done');
  if (fs.existsSync(playlist) && fs.existsSync(doneFile)) return Promise.resolve(playlist);
  const jobKey = `${site.key}:${vid}`;
  if (hlsJobs.has(jobKey)) return hlsJobs.get(jobKey);
  const job = (async () => {
    hlsEvict();
    fs.mkdirSync(dir, { recursive: true });
    // 清掉上一轮残留
    for (const f of fs.readdirSync(dir)) {
      if (f !== '.done') {
        try {
          fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        } catch {}
      }
    }
    try {
      fs.rmSync(doneFile, { force: true });
    } catch {}
    const mp4 = await resolveMp4(site, vid);
    console.log(`[hls][${site.key}] ${vid} remux start`);
    const segPattern = path.join(dir, 's%05d.ts');
    const inputArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-headers',
      `Referer: ${site.base}/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n`,
      '-i',
      mp4,
    ];
    const hlsArgs = [
      '-map', '0:v:0', '-map', '0:a:0?',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
      '-hls_segment_filename', segPattern, playlist,
    ];
    try {
      await ffExec(['-y', ...inputArgs, '-c', 'copy', ...hlsArgs]);
    } catch (e) {
      // copy 失败（如音频编码不兼容）则音频转 aac 重试一次
      console.log(`[hls][${site.key}] ${vid} copy failed, retry with aac: ${String((e && e.message) || e).slice(0, 200)}`);
      await ffExec(['-y', ...inputArgs, '-c:v', 'copy', '-c:a', 'aac', ...hlsArgs]);
    }
    if (!fs.existsSync(playlist)) throw new Error('hls playlist not generated');
    fs.writeFileSync(doneFile, String(Date.now()));
    console.log(`[hls][${site.key}] ${vid} remux done`);
    return playlist;
  })();
  hlsJobs.set(jobKey, job);
  job.catch(() => {}).finally(() => hlsJobs.delete(jobKey));
  return job;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// POST 搜索时把 body 参数并入 query (部分聚合端用 POST)
app.use((req, _, next) => {
  req.query = { ...(req.body || {}), ...(req.query || {}) };
  next();
});

app.get('/health', (_, res) => res.json({ ok: true, sites: [...sites.keys()], time: fmtTime() }));

// 直链解析: /play?site=<site>&v=VID -> 302 到最高清晰度; ?format=json 返回 JSON
// 每次都绕过 html 缓存实时解析 (mp4 token 有效期短, 不能用缓存)
async function handlePlay(req, res) {
  const v = req.query.v || req.query.vid || req.query.id;
  const site = siteOf(req.query.site || req.params.site || DEFAULT_SITE);
  if (!site) return res.status(404).json({ code: 0, msg: 'unknown site' });
  if (!v) return res.status(400).json({ code: 0, msg: 'missing ?v=vid' });
  try {
    cache.delete('html:' + detailPageUrl(site, v));
    const { metaHtml, playHtml } = await fetchPlayableHtml(site, v);
    const d = site.def.parseDetail(metaHtml, String(v), playHtml);
    if (!d.sources.length) return res.status(404).json({ code: 0, msg: 'no playable source' });
    const best = d.sources[0];
    if (req.query.format === 'json')
      return res.json({ code: 1, site: site.key, vid: String(v), url: best.src, sources: d.sources });
    res.redirect(best.src);
  } catch (e) {
    res.status(502).json({ code: 0, msg: String(e.message || e) });
  }
}
app.all(['/play', '/:site([a-z0-9-]+)/play'], handlePlay);

// HLS: /h/<site>/<vid>/index.m3u8 + 切片（兼容老地址 /h/<vid>/... → 默认站）
// mp4 仅转封装 (-c copy), 不转码; 切好后是完整 VOD, 切片落本地可反复播
async function handleHlsPlaylist(req, res) {
  const site = siteOf(req.params.site || DEFAULT_SITE);
  const vid = req.params.vid || '';
  if (!site) return res.status(404).json({ code: 0, msg: 'unknown site' });
  if (!/^\d+$/.test(vid)) return res.status(400).json({ code: 0, msg: 'bad vid' });
  try {
    const p = await ensureHls(site, vid);
    res.type('application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    const msg = 'hls failed: ' + String((e && e.message) || e).slice(0, 300);
    console.error(`[hls][${site.key}] ${vid} ${msg}`);
    res.status(502).json({ code: 0, msg });
  }
}
app.get('/h/:site([a-z0-9-]+)/:vid/index.m3u8', handleHlsPlaylist);
app.get('/h/:vid/index.m3u8', handleHlsPlaylist);

app.get(['/h/:site([a-z0-9-]+)/:vid/:seg', '/h/:vid/:seg'], (req, res) => {
  const site = siteOf(req.params.site || DEFAULT_SITE);
  if (!site) return res.status(404).end();
  const vid = req.params.vid || '';
  const seg = req.params.seg || '';
  if (!/^\d+$/.test(vid) || !/^[A-Za-z0-9]+\.ts$/.test(seg)) return res.status(400).end();
  const dir = hlsVidDir(site, vid);
  const f = path.resolve(dir, seg);
  if (!f.startsWith(path.resolve(dir) + path.sep) && f !== path.resolve(dir)) return res.status(400).end();
  if (!fs.existsSync(f)) return res.status(404).end();
  res.type('video/mp2t');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(f).pipe(res);
});

async function handleList(site, req, res) {
  const q = req.query;
  const pg = Math.max(1, parseInt(q.pg || q.page || q.p || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || q.pagesize || '20', 10) || 20));
  const t = q.t || q.type || q.tid || q.type_id || '';
  const wd = (q.wd || q.keyword || q.query || '').trim();

  let url;
  let typeName = '';
  // 适配器可选钩子：先让站点把动态分类并进来（如 hohoj 的站内导航标签库），
  // 失败也不影响（回退内置 CATS），绝不能抛到外层。
  try {
    if (site.def.ensureNavCats) await site.def.ensureNavCats(site.base, fetch);
  } catch {}
  if (wd) {
    url = site.def.buildSearchUrl({ query: wd, pg }, site.base);
  } else if (t && site.def.catById(t)) {
    const c = site.def.catById(t);
    typeName = c.type_name;
    url = site.def.buildSearchUrl({ genre: c.genre, sort: c.sort, pg }, site.base);
  } else if (t) {
    // 允许直接传 genre 中文: ?t=裏番
    typeName = String(t);
    url = site.def.buildSearchUrl({ genre: String(t), pg }, site.base);
  } else {
    url = site.def.buildSearchUrl({ pg }, site.base);
  }

  try {
    const html = await fetchHtml(site, url);
    const items = site.def.parseList(html);
    const pagecount = Math.max(pg, site.def.parsePageCount(html, pg));
    const total = pagecount * limit;
    const list = items.slice(0, limit).map((v) => ({
      vod_id: v.vid,
      vod_name: v.title,
      type_id: t ? Number(t) || t : site.def.CATS[0] ? site.def.CATS[0].type_id : 1,
      type_name: typeName || (t ? String(t) : site.def.CATS[0] ? site.def.CATS[0].type_name : ''),
      vod_pic: v.pic,
      vod_remarks: '',
      vod_time: fmtTime(),
      vod_play_from: site.def.displayName,
      // 直通站（原生 m3u8，如 missav）：列表不拼选集，详情页自带直链；
      // 非直通站：列表带单集 HLS（MoonPlus 只收录 .m3u8 且按 episodes.length 过滤）
      vod_play_url:
        !site.def.passthrough && site.publicBase
          ? `正片$${site.publicBase}/h/${site.key}/${v.vid}/index.m3u8`
          : undefined,
    }));
    res.__listLen = list.length;
    res.json({
      code: 1,
      msg: '数据列表',
      page: pg,
      pagecount,
      limit,
      total,
      list,
      class: site.def.CATS.map((c) => ({ type_id: c.type_id, type_name: c.type_name, ...(c.group ? { group: c.group } : {}) })),
    });
  } catch (e) {
    res.status(502).json({ code: 0, msg: '上游抓取失败: ' + (e.message || e) });
  }
}

async function handleDetail(site, req, res) {
  const q = req.query;
  let ids = (q.ids || q.vod_id || q.id || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 兼容 ac=detail&t=1&pg=1 (返回该分类第一页的详情, 限 10 个防雪崩)
  if (!ids.length && (q.t || q.wd || q.keyword)) {
    try {
      if (site.def.ensureNavCats) await site.def.ensureNavCats(site.base, fetch);
    } catch {}
    const pg = Math.max(1, parseInt(q.pg || q.page || '1', 10) || 1);
    const wd = (q.wd || q.keyword || '').trim();
    const t = q.t || '';
    let url;
    if (wd) url = site.def.buildSearchUrl({ query: wd, pg }, site.base);
    else if (site.def.catById(t)) {
      const c = site.def.catById(t);
      url = site.def.buildSearchUrl({ genre: c.genre, sort: c.sort, pg }, site.base);
    } else url = site.def.buildSearchUrl({ pg }, site.base);
    try {
      const html = await fetchHtml(site, url);
      ids = site.def.parseList(html).slice(0, 10).map((v) => v.vid);
    } catch (e) {
      return res.status(502).json({ code: 0, msg: '上游抓取失败: ' + (e.message || e) });
    }
  }
  if (!ids.length) return res.status(400).json({ code: 0, msg: 'missing ?ids=vid1,vid2' });
  ids = ids.slice(0, 20); // 单次最多 20, 防上游限流

  try {
    // 并发限 5 + 单 vid 失败只丢该条：一个详情挂了不整单 502
    const CONC = 5;
    const results = [];
    for (let i = 0; i < ids.length; i += CONC) {
      const batch = await Promise.all(
        ids.slice(i, i + CONC).map(async (vid) => {
          try {
            const ckey = `detail:${site.key}:` + vid;
            const cached = cacheGet(ckey);
            if (cached) return cached;
            const { metaHtml, playHtml } = await fetchPlayableHtml(site, vid);
            const d = site.def.parseDetail(metaHtml, vid, playHtml);
            // PUBLIC_BASE 指向本服务公网地址时, 选集拼 HLS 直链 (MoonPlus 只收录 .m3u8);
            // 直通站 episodes 自带 url（上游原生 m3u8），原样透传，不走 /h/ 转封装；
            // 否则拼上游站 watch 页 (仅跳转)
            const epLink = (e) =>
              e.url ||
              (site.publicBase
                ? `${site.publicBase}/h/${site.key}/${e.vid}/index.m3u8`
                : `${site.base}/watch?v=${e.vid}`);
            const playUrl = d.episodes.map((e) => `${e.name}$${epLink(e)}`).join('#');
            const bestQ = d.sources.length && d.sources[0].size ? `${d.sources[0].size}p` : '';
            const vod = {
              vod_id: vid,
              vod_name: d.title,
              type_id: site.def.CATS[0] ? site.def.CATS[0].type_id : 1,
              type_name: d.genreName || (site.def.CATS[0] ? site.def.CATS[0].type_name : ''),
              vod_pic: d.pic,
              vod_actor: d.actor,
              vod_content: d.desc,
              vod_remarks: bestQ || `${d.episodes.length}集`,
              vod_year: '',
              vod_area: '',
              vod_lang: '',
              vod_time: fmtTime(),
              vod_play_from: site.def.displayName,
              vod_play_server: '',
              vod_play_note: '',
              vod_play_url: playUrl,
              vod_tag: (d.tags || []).join(','),
              vod_class: (d.tags || []).join(','),
            };
            cacheSet(ckey, vod, site.def.detailTtlMs || Math.min(CACHE_TTL, 86400 * 1000));
            // 轻微限流
            await new Promise((r) => setTimeout(r, 120));
            return vod;
          } catch (err) {
            console.warn(`[detail][${site.key}] ${vid} 失败跳过: ${(err && err.message) || err}`);
            return null;
          }
        })
      );
      for (const v of batch) if (v) results.push(v);
    }
    if (!results.length) return res.status(502).json({ code: 0, msg: '上游抓取失败' });
    res.__listLen = results.length;
    res.json({
      code: 1,
      msg: '数据列表',
      page: 1,
      pagecount: 1,
      limit: String(results.length),
      total: results.length,
      list: results,
      class: site.def.CATS.map((c) => ({ type_id: c.type_id, type_name: c.type_name, ...(c.group ? { group: c.group } : {}) })),
    });
  } catch (e) {
    res.status(502).json({ code: 0, msg: '上游抓取失败: ' + (e.message || e) });
  }
}

function dispatchWith(siteName, req, res) {
  const site = siteOf(siteName);
  if (!site) return res.status(404).json({ code: 0, msg: `unknown site: ${siteName}` });
  const t0 = Date.now();
  const q = req.query;
  const ac = (q.ac || '').toLowerCase();
  const summary = `site=${site.key} ac=${ac || '(none)'} t=${q.t || ''} pg=${q.pg || q.page || ''} wd=${(q.wd || q.keyword || q.query || '').slice(0, 30)} ids=${String(q.ids || '').slice(0, 60)}`;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${summary}`);
  res.on('finish', () => {
    try {
      const len = res.__listLen;
      if (len !== undefined) console.log(`  -> ${len} items in ${Date.now() - t0}ms`);
    } catch {}
  });
  // 单个源报错绝不能掀翻整个网关进程：同步 throw（如 aqdlt 拒搜）直接 502；
  // 异步 handle 统一挂 catch（Express 4 不收 async  rejection，不接就变 unhandledRejection 崩进程）
  let p;
  try {
    if (ac === 'detail' || (q.ids && !ac)) p = handleDetail(site, req, res);
    else if (ac === 'list' || ac === '' || ac === 'videolist') {
      // ?ids= 优先走详情 (MacCMS 采集器行为)
      if (q.ids) p = handleDetail(site, req, res);
      else p = handleList(site, req, res);
    } else if (
      (ac === 'models' || ac === 'model-videos') &&
      typeof site.def.handleModels === 'function'
    ) {
      // 站点扩展位（如 hohoj 女优墙/女优作品），走 MacCMS 信封
      p = site.def.handleModels(site, req, res, ac);
    } else {
      return res.status(400).json({ code: 0, msg: 'unknown ac, use ac=list|detail' });
    }
  } catch (e) {
    console.error(`[hub][${site.key}] dispatch sync failed: ${(e && e.message) || e}`);
    if (!res.headersSent) return res.status(502).json({ code: 0, msg: '上游抓取失败: ' + ((e && e.message) || e) });
    return;
  }
  Promise.resolve(p).catch((e) => {
    console.error(`[hub][${site.key}] dispatch async failed: ${(e && e.message) || e}`);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: '上游抓取失败: ' + ((e && e.message) || e) });
  });
  return p;
}

// MacCMS 标准路径 + 兼容路径 (GET/POST 都接, 部分聚合端用 POST 搜索)
// 带站点前缀（多站共存）：
app.all(
  [
    '/:site([a-z0-9-]+)/api.php/provide/vod/',
    '/:site([a-z0-9-]+)/api.php/provide/vod',
    '/:site([a-z0-9-]+)/api/provide/vod',
    '/:site([a-z0-9-]+)/vod',
    '/:site([a-z0-9-]+)/provide/vod',
  ],
  (req, res) => dispatchWith(req.params.site, req, res)
);
// 无前缀（兼容老 hanime1-maccms 地址 → DEFAULT_SITE）：
app.all(
  ['/api.php/provide/vod/', '/api.php/provide/vod', '/api/provide/vod', '/vod', '/provide/vod'],
  (req, res) => dispatchWith(DEFAULT_SITE, req, res)
);

// 根路径 ?ac=list 可直接用 (方便 MoonTV custom API 测试)；无参数时列出站点
app.all('/', (req, res) => {
  if (req.query.ac || req.query.wd || req.query.ids || req.query.t)
    return dispatchWith(req.query.site || DEFAULT_SITE, req, res);
  const demo = siteOf(DEFAULT_SITE);
  res.json({
    ok: true,
    name: 'maccms-hub',
    sites: [...sites.keys()],
    usage: demo ? `/api.php/provide/vod/?ac=list&t=${demo.def.CATS[0]?.type_id ?? 1}&pg=1` : '',
    usage_prefixed: demo ? `/${demo.key}/api.php/provide/vod/?ac=list&t=${demo.def.CATS[0]?.type_id ?? 1}&pg=1` : '',
    play: '/play?site=<site>&v=<vid>',
    class: demo ? demo.def.CATS : [],
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`[maccms-hub] listening :${PORT} sites=${[...sites.keys()].join(',')}`));
}

module.exports = { app, sites, siteOf, DEFAULT_SITE, buildRelayUrl, __relayTest: { acquire: relayAcquire, release: relayRelease } };
