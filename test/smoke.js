'use strict';

/* 离线冒烟测试：node test/smoke.js（无需上游网络，exit code 非 0 即失败） */

const assert = require('assert');

async function main() {
  const hanime1 = require('../src/sites/hanime1');
  const tmpl = require('../src/sites/_template');

  // 1. 适配器元信息
  assert.strictEqual(hanime1.key, 'hanime1');
  assert.ok(hanime1.CATS.length >= 13, `hanime1 CATS=${hanime1.CATS.length}`);
  assert.strictEqual(hanime1.catById(4).type_name, '裏番');
  assert.strictEqual(hanime1.catById('4').type_name, '裏番');
  assert.ok(Array.isArray(tmpl.CATS), '模板也应可被 require（仅做结构校验）');

  // 2. 列表 URL 拼装
  const url = hanime1.buildSearchUrl({ genre: '裏番', sort: '', pg: 2 }, 'https://hanime1.me');
  assert.ok(url.startsWith('https://hanime1.me/search?'), url);
  assert.ok(url.includes('page=2'), url);

  // 3. parseList：首页卡片形态
  const listHtml = `
    <div class="video-item-container" title="完整标题全称">
      <a href="/watch?v=115211">
        <div class="home-rows-videos-title">缩写</div>
        <img src="https://cdn.example.com/pic.jpg">
      </a>
    </div>`;
  const items = hanime1.parseList(listHtml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].vid, '115211');
  assert.strictEqual(items[0].title, '完整标题全称');
  assert.strictEqual(items[0].pic, 'https://cdn.example.com/pic.jpg');

  // 4. parseDetail：og + source + playlist + tags
  const detailHtml = `
    <html><head>
      <meta property="og:title" content="某里番 - Hanime1.me">
      <meta property="og:image" content="https://cdn.example.com/cover.jpg">
      <meta property="og:description" content="简介">
    </head><body>
      <source size="720" src="https://cdn.example.com/720.mp4">
      <source size="1080" src="https://cdn.example.com/1080.mp4">
      <div id="playlist-scroll">
        <div class="playlist-hover-wrap" data-href="/watch?v=115211">
          <div class="video-title"><a>第1話</a></div>
        </div>
      </div>
      <div class="single-video-tag"><a href="/search?query=x">#學園 (12)</a></div>
    </body></html>`;
  const d = hanime1.parseDetail(detailHtml, '115211');
  assert.strictEqual(d.title, '某里番');
  assert.strictEqual(d.sources[0].src, 'https://cdn.example.com/1080.mp4', '直链应按清晰度降序');
  assert.strictEqual(d.episodes[0].vid, '115211');
  assert.strictEqual(d.episodes[0].name, '第1話');
  assert.deepStrictEqual(d.tags, ['學園']);

  // 4b. bjcam 适配器（WP 录播站，离线 fixture 断言）
  const bjcam = require('../src/sites/bjcam');
  assert.strictEqual(bjcam.key, 'bjcam');
  assert.strictEqual(bjcam.CATS.length, 3);
  assert.strictEqual(bjcam.catById(2).genre, 'korean-bj');
  assert.strictEqual(bjcam.useRelay, true, '整站 CF 拦截，必须走中转');
  assert.deepStrictEqual(bjcam.directHosts, ['video.playerrecord.cfd', 'playrecord.biz']);
  assert.strictEqual(bjcam.noCachePlayHtml, true);
  assert.strictEqual(
    bjcam.buildSearchUrl({ pg: 2 }, 'https://sexbjcam.com'),
    'https://sexbjcam.com/page/2/?filter=latest'
  );
  assert.strictEqual(
    bjcam.buildSearchUrl({ genre: 'korean-bj', pg: 3 }, 'https://sexbjcam.com'),
    'https://sexbjcam.com/category/korean-bj/page/3/'
  );
  assert.strictEqual(
    bjcam.buildSearchUrl({ query: 'panda', pg: 1 }, 'https://sexbjcam.com'),
    'https://sexbjcam.com/?s=panda'
  );
  const bjListHtml = `
    <article class="thumb-block video-preview-item post-386741" data-post-id="386741">
      <a href="https://sexbjcam.com/2026/11/07/kbj26110788_pandaclass_20261103/" title="kbj26110788_PandaClass_20261103">
        <div class="post-thumbnail-container"><img class="video-main-thumb" src="https://sexbjcam.com/wp-content/uploads/2026/11/kbj26110788.jpg"></div>
        <span class="duration"><i class="fa fa-clock-o"></i>52:39</span>
        <header class="entry-header"><span>kbj26110788_PandaClass_20261103</span></header>
      </a>
    </article>`;
  const bjItems = bjcam.parseList(bjListHtml);
  assert.strictEqual(bjItems.length, 1);
  assert.strictEqual(bjItems[0].vid, '386741');
  assert.strictEqual(bjItems[0].title, 'kbj26110788_PandaClass_20261103');
  assert.ok(bjItems[0].pic.includes('kbj26110788.jpg'));
  assert.strictEqual(bjItems[0].sub, '52:39');
  const bjPageHtml = `<div class="pagination"><ul>
    <li><a class="current">1</a></li>
    <li><a href="https://sexbjcam.com/category/korean-bj/page/4/" class="inactive">4</a></li>
  </ul></div>`;
  assert.strictEqual(bjcam.parsePageCount(bjPageHtml, 1), 4);
  assert.strictEqual(bjcam.detailUrl('386741', 'https://sexbjcam.com'), 'https://sexbjcam.com/?p=386741');
  const bjMeta = `<html><head>
      <meta property="og:title" content="kbj26110788_PandaClass_20261103">
      <meta property="og:image" content="https://sexbjcam.com/wp-content/uploads/2026/11/kbj26110788.jpg">
    </head><body>
      <a href="/category/korean-bj/">KOREAN BJ</a>
      <iframe src="https://video.playerrecord.cfd/e/tjocwawxobtv"></iframe>
    </body></html>`;
  const bjPlayUrl = bjcam.expandDetailUrl(bjMeta, '386741', 'https://sexbjcam.com');
  assert.ok(
    bjPlayUrl.startsWith('https://video.playerrecord.cfd/app/v1/play/tjocwawxobtv?embed=1&ref='),
    bjPlayUrl
  );
  const bjDetail = bjcam.parseDetail(
    bjMeta,
    '386741',
    JSON.stringify({ hls: 'https://cdn.example.com/x/master.m3u8', mp4: '', title: 't_merged', poster: '' })
  );
  assert.strictEqual(bjDetail.title, 'kbj26110788_PandaClass_20261103');
  assert.strictEqual(bjDetail.episodes.length, 1);
  assert.strictEqual(bjDetail.episodes[0].url, 'https://cdn.example.com/x/master.m3u8');
  assert.deepStrictEqual(bjDetail.tags, ['KOREAN BJ']);

  // 4c. bjcam 旧 embed（playrecord.biz，packer 混淆 jwplayer）：解码提流
  const packedSample = String.raw`eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\b'+c.toString(a)+'\b','g'),k[c]);return p}('0={"1":"10://11.100/101/x.m3u8"};0',2,6,'links|hls2|https|cdn|x|master'.split('|')))`;
  const unpacked = bjcam.unpackDeanEdwards(packedSample);
  assert.ok(
    unpacked.includes('https://cdn.x/master/x.m3u8'),
    unpacked.slice(0, 120)
  );
  const oldMetaHtml = '<html><body><iframe src="https://playrecord.biz/embed/cb6ohcnf08a8"></iframe></body></html>';
  assert.strictEqual(
    bjcam.expandDetailUrl(oldMetaHtml, '777', 'https://sexbjcam.com'),
    'https://playrecord.biz/embed/cb6ohcnf08a8'
  );
  const oldPlayHtml = 'jwplayer("vplayer").setup({sources:[{file:"https://cdn.example.com/o/master.m3u8",type:"hls"}],image:"x"});'
    + 'var links={"hls2":"https://cdn.example.com/o/master.m3u8"};';
  const oldDetail = bjcam.parseDetail(bjMeta, '777', oldPlayHtml);
  assert.strictEqual(oldDetail.episodes.length, 1);
  assert.strictEqual(oldDetail.episodes[0].url, 'https://cdn.example.com/o/master.m3u8');

  // 5. 框架路由（离线断言，不碰上游）
  const { app } = require('../src/server');
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = srv.address().port;
  try {
    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      const body = await r.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {}
      return { status: r.status, json };
    };

    const root = await get('/');
    assert.strictEqual(root.status, 200);
    assert.strictEqual(root.json.ok, true);
    assert.ok(root.json.sites.includes('hanime1'), JSON.stringify(root.json));

    const health = await get('/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);

    const badSite = await get('/nosuchsite/api.php/provide/vod/?ac=list');
    assert.strictEqual(badSite.status, 404);

    const badAc = await get('/api.php/provide/vod/?ac=foo');
    assert.strictEqual(badAc.status, 400);

    const badAcPrefixed = await get('/hanime1/api.php/provide/vod/?ac=foo');
    assert.strictEqual(badAcPrefixed.status, 400);

    // 不支持搜索的站：返回 502 JSON，而不是掀翻进程
    const noSearch = await get('/aqdlt/api.php/provide/vod/?ac=list&wd=test');
    assert.strictEqual(noSearch.status, 502);
    assert.strictEqual(noSearch.json.code, 0);

    const missingIds = await get('/api.php/provide/vod/?ac=detail');
    assert.strictEqual(missingIds.status, 400);

    const missingVid = await get('/play?site=hanime1');
    assert.strictEqual(missingVid.status, 400);
  } finally {
    srv.close();
  }

  // 6. 中转排队：同一事件循环内串行化（RELAY_MAX_CONCURRENT=1 时验证 FIFO）
  delete require.cache[require.resolve('../src/server')];
  process.env.RELAY_MAX_CONCURRENT = '1';
  const hub2 = require('../src/server');
  let order = [];
  const p1 = hub2.__relayTest.acquire().then(() => order.push('first'));
  const p2 = hub2.__relayTest.acquire().then(() => order.push('second'));
  await new Promise((r) => setImmediate(r)); // 让第二次 acquire 进入队列
  assert.deepStrictEqual(order, ['first']); // 第一个立即拿到，第二个排队
  hub2.__relayTest.release(); // 释放 → 第二个拿到
  await p1;
  await p2;
  assert.deepStrictEqual(order, ['first', 'second']);
  hub2.__relayTest.release();
  delete process.env.RELAY_MAX_CONCURRENT;
  const { buildRelayUrl } = require('../src/server');
  const prevKey = process.env.SCRAPERAPI_KEY;
  process.env.SCRAPERAPI_KEY = 'testkey123';
  const relayUrl = buildRelayUrl('https://example.com/list');
  assert.ok(
    relayUrl ===
      'http://api.scraperapi.com?api_key=testkey123&url=https%3A%2F%2Fexample.com%2Flist&render=true',
    relayUrl
  );
  delete process.env.SCRAPERAPI_KEY;
  assert.strictEqual(buildRelayUrl('https://example.com/'), null);
  if (prevKey !== undefined) process.env.SCRAPERAPI_KEY = prevKey;

  // 7. fetchHtml 新钩子（localhost 桩，离线可测）：directHosts 命中走直连、
  //    不命中走中转；noCache 跳过 html: 缓存
  const http = require('http');
  let stubHits = 0;
  const stub = http.createServer((req, res) => {
    stubHits++;
    if (req.url.startsWith('/challenged')) {
      res.writeHead(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' });
      res.end('<html><head><title>Just a moment...</title></head></html>');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hls: 'https://cdn.example.com/x/master.m3u8' }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;
  const stubUrl = `http://127.0.0.1:${stubPort}/app/v1/play/abc?embed=1`;
  const mkSite = (def) => ({
    key: 't', base: `http://127.0.0.1:${stubPort}`, publicBase: '', def,
  });
  const directDef = {
    useRelay: true, directHosts: ['127.0.0.1'], UA_LIST: [], headersFor: () => ({}),
  };
  process.env.SCRAPERAPI_KEY = 'testkey123';
  const { fetchHtml } = require('../src/server');
  stubHits = 0;
  const d1 = JSON.parse(await fetchHtml(mkSite(directDef), stubUrl));
  assert.strictEqual(d1.hls, 'https://cdn.example.com/x/master.m3u8', '命中 directHosts 必须直连（中转假 key 会失败）');
  assert.strictEqual(stubHits, 1);
  const d2 = await fetchHtml(mkSite(directDef), stubUrl);
  assert.strictEqual(stubHits, 1, '默认应命中 html: 缓存');
  assert.ok(d2.includes('master.m3u8'));
  await fetchHtml(mkSite(directDef), stubUrl, { noCache: true });
  assert.strictEqual(stubHits, 2, 'noCache 应每次现抓');
  // 不命中 directHosts → 走中转（假 key 下必抛，绝不能回落到桩内容；换未缓存过的 URL，避免上面直连写进的缓存干扰）
  let relayAttempted = false;
  try {
    const r = await fetchHtml(mkSite({ useRelay: true, UA_LIST: [], headersFor: () => ({}) }), stubUrl + '&other=1');
    relayAttempted = !String(r).includes('master.m3u8');
  } catch {
    relayAttempted = true;
  }
  assert.ok(relayAttempted, '未命中 directHosts 必须走中转');
  // relayOnChallenge：直连能过则直接用（不花中转）；遇挑战标记才转中转
  const autoSite = mkSite({ useRelay: true, relayOnChallenge: true, UA_LIST: [], headersFor: () => ({}) });
  stubHits = 0;
  const a1 = await fetchHtml(autoSite, stubUrl + '&auto=1');
  assert.ok(String(a1).includes('master.m3u8'), '直连能过时不应中转');
  let challengedToRelay = false;
  try {
    await fetchHtml(autoSite, `http://127.0.0.1:${stubPort}/challenged`);
  } catch (e) {
    challengedToRelay = /SCRAPERAPI_KEY is missing|relay http|fetch failed/i.test(String((e && e.message) || e));
  }
  delete process.env.SCRAPERAPI_KEY;
  assert.ok(challengedToRelay, '遇 CF 挑战标记必须转中转');
  if (prevKey !== undefined) process.env.SCRAPERAPI_KEY = prevKey;
  stub.close();

  // 8. aqdlt 适配器（sojson 还原 + 原生 m3u8 直传）
  const aqdlt = require('../src/sites/aqdlt');
  assert.strictEqual(aqdlt.key, 'aqdlt');
  assert.strictEqual(aqdlt.passthrough, true);
  // 导航同步后可能已并入动态分类（在线时 13+；离线回退 13）
  assert.ok(aqdlt.CATS.length >= 13, `aqdlt CATS=${aqdlt.CATS.length}`);
  if (aqdlt.CATS.length > 13) {
    assert.ok(aqdlt.catById('cat-hk'), '应含导航分类 cat-hk');
  }
  assert.strictEqual(
    aqdlt.detailUrl('50419', 'https://vip.aqdm888.com:20844'),
    'https://vip.aqdm888.com:20844/videos/play/50419.html'
  );
  assert.strictEqual(aqdlt.buildSearchUrl({ pg: 1 }, 'https://vip.aqdm888.com:20844'), 'https://vip.aqdm888.com:20844/');
  assert.ok(aqdlt.buildSearchUrl({ pg: 2 }, 'https://vip.aqdm888.com:20844').endsWith('/videos/index/2.html'));
  assert.ok(
    aqdlt.buildSearchUrl({ genre: '/videos/category/cn.html', pg: 1 }, 'https://vip.aqdm888.com:20844').endsWith('/videos/category/cn.html')
  );
  assert.throws(() => aqdlt.buildSearchUrl({ query: 'test', pg: 1 }, 'https://vip.aqdm888.com:20844'), /not supported/);
  assert.strictEqual(aqdlt.parsePageCount('第 1 页 / 共 2794 页', 1), 500);

  // sojson 载荷：反转字符串 + 解码桩 document.write 还原
  // 真实卡片是双锚点（缩略图卡标题在 alt 里 + 标题行全标题），合并后取最长标题+真实封面
  const aqInner =
    '<div><a href="/videos/play/50419.html" alt="糖心Vlog 完整标题文字"><img src="https://img14.360buyimg.com/ddimg/jfs/t1/170741/16/31531/4135/635abc45E3a8484bb/7f0fec842f6b8fea.png" data-src="https://img2.fuqiu1688.com:606/thumbs/050/50419_cover_480x270.jpg" alt="糖心Vlog 完整标题文字"></a>' +
    '<a href="/videos/play/50419.html">糖心Vlog 完整标题文字</a>' +
    '<a href="/videos/category/cn.html">中國大陸</a></div>';
  const aqPayload = aqInner.split('').reverse().join('');
  const aqStub = "document.write(decodeURIComponent(html.split('').reverse().join('')));";
  const aqPage = `<html><body><script>var html = '${aqPayload}';</script><script>${aqStub}</script></body></html>`;
  const aqItems = aqdlt.parseList(aqPage);
  assert.strictEqual(aqItems.length, 1, JSON.stringify(aqItems));
  assert.strictEqual(aqItems[0].vid, '50419');
  assert.strictEqual(aqItems[0].title, '糖心Vlog 完整标题文字');
  assert.ok(aqItems[0].pic.includes('50419_cover_480x270.jpg'), aqItems[0].pic);

  const aqDetailInner =
    '<html><head><meta property="og:title" content="糖心Vlog 标题"></head><body><h1>糖心Vlog 标题</h1>' +
    '<a href="/videos/category/cn.html">中國大陸</a>' +
    '<a href="/videos/tag/beauty-breast.html">美乳</a>' +
    '<script>var player="https://cdn.aqd-tv.com/video/594c5149/playlist/594c5149.m3u8";</script></body></html>';
  const aqDetailPage =
    `<html><body><script>var html = '${aqDetailInner.split('').reverse().join('')}';</script><script>${aqStub}</script></body></html>`;
  const aqD = aqdlt.parseDetail(aqDetailPage, '50419');
  assert.strictEqual(aqD.title, '糖心Vlog 标题');
  assert.strictEqual(aqD.genreName, '中國大陸');
  assert.deepStrictEqual(aqD.tags, ['中國大陸', '美乳']);
  assert.strictEqual(aqD.sources[0].src, 'https://cdn.aqd-tv.com/video/594c5149/playlist/594c5149.m3u8');
  assert.strictEqual(aqD.episodes[0].url, 'https://cdn.aqd-tv.com/video/594c5149/playlist/594c5149.m3u8');

  // 9. hohoj 适配器（iframe 二跳 + 原生 m3u8 直传）
  const hohoj = require('../src/sites/hohoj');
  assert.strictEqual(hohoj.key, 'hohoj');
  assert.strictEqual(hohoj.passthrough, true);
  // 导航同步后可能已并入动态分类（在线时 13+；离线回退 13）
  assert.ok(hohoj.CATS.length >= 13, `hohoj CATS=${hohoj.CATS.length}`);
  assert.strictEqual(
    hohoj.detailUrl('7557', 'https://hohoj.tv'),
    'https://hohoj.tv/video?id=7557'
  );
  assert.strictEqual(
    hohoj.expandDetailUrl('<iframe src="/embed?id=7557">', '7557', 'https://hohoj.tv'),
    'https://hohoj.tv/embed?id=7557'
  );
  assert.strictEqual(hohoj.expandDetailUrl('<div>无播放器</div>', '1', 'https://hohoj.tv'), null);
  assert.ok(hohoj.buildSearchUrl({ query: 'test', pg: 1 }, 'https://hohoj.tv').includes('/search?text=test'));
  assert.strictEqual(
    hohoj.buildSearchUrl({ genre: '/search?type=uncensored', pg: 1 }, 'https://hohoj.tv'),
    'https://hohoj.tv/search?type=uncensored'
  );
  const hoItems = hohoj.parseList(
    '<div><a href="/video?id=7557" title="测试标题"><img src="https://x/cover.jpg"></a>' +
      '<a href="/search?type=uncensored">無碼</a></div>'
  );
  assert.strictEqual(hoItems.length, 1, JSON.stringify(hoItems));
  assert.strictEqual(hoItems[0].vid, '7557');
  assert.strictEqual(
    hohoj.parseDetail('<h1>T</h1>', '7557', '<script>var u="https://cdn/x/playlist.m3u8";</script>').episodes[0].url,
    'https://cdn/x/playlist.m3u8'
  );

  // 10. kinostream 适配器（直连 SSR + 原生 m3u8 直传，token 短效）
  const kino = require('../src/sites/kinostream');
  assert.strictEqual(kino.key, 'kinostream');
  assert.strictEqual(kino.passthrough, true);
  assert.strictEqual(kino.skipHtmlCache, true);
  assert.strictEqual(kino.CATS.length, 6);
  assert.strictEqual(kino.catById(1).type_name, '最新上架');
  assert.strictEqual(
    kino.buildSearchUrl({ query: '鯊瘋', pg: 1 }, 'https://kinostream.com'),
    'https://kinostream.com/cloud/search?term=%E9%AF%8A%E7%98%8B'
  );
  assert.strictEqual(
    kino.buildSearchUrl({ genre: '最新上架', pg: 2 }, 'https://kinostream.com'),
    'https://kinostream.com/vod/category/%E6%9C%80%E6%96%B0%E4%B8%8A%E6%9E%B6'
  );
  assert.strictEqual(
    kino.buildSearchUrl({ pg: 1 }, 'https://kinostream.com'),
    'https://kinostream.com/vod'
  );
  assert.strictEqual(
    kino.detailUrl('5239', 'https://kinostream.com'),
    'https://kinostream.com/cloud/vod/5239'
  );
  assert.strictEqual(kino.parsePageCount('<div>无翻页</div>', 3), 3);
  // 分类网格卡（img src 直链 + h3/h4）
  const kItems = kino.parseList(
    '<div class="con_post"><div class="con_post_box">' +
      '<img src="https://flicksbank.console360.net/images/5239/default.jpg" alt="鯊瘋了">' +
      '<a href="/cloud/vod/5239"><div><h3>鯊瘋了</h3><h4>Shark Frenzy</h4></div></a>' +
      '</div></div>' +
      '<div class="con_post"><div class="con_post_box">' +
      '<img src="https://flicksbank.console360.net/images/5239/default.jpg" alt="鯊瘋了">' +
      '<a href="/cloud/vod/5239"><div><h3>鯊瘋了</h3></div></a>' +
      '</div></div>'
  );
  assert.strictEqual(kItems.length, 1, JSON.stringify(kItems));
  assert.strictEqual(kItems[0].vid, '5239');
  assert.strictEqual(kItems[0].title, '鯊瘋了');
  assert.strictEqual(kItems[0].pic, 'https://flicksbank.console360.net/images/5239/default.jpg');
  // 首页行卡（img data-src 懒加载 + h1）
  const kHome = kino.parseList(
    '<div class="swiper-slide card" data-id="5198"><a href="/cloud/vod/5198">' +
      '<img data-src="https://flicksbank.console360.net/images/5198/default.jpg">' +
      '<div class="card_cover_inner"><h1>外星人：揭密日</h1></div></a></div>'
  );
  assert.strictEqual(kHome.length, 1);
  assert.strictEqual(kHome[0].vid, '5198');
  assert.strictEqual(kHome[0].title, '外星人：揭密日');
  assert.ok(kHome[0].pic.includes('5198/default.jpg'));
  // 详情：ld+json + 内联 m3u8（m3u8 从 /cloud/play 子页提，框架经 expandDetailUrl 跟进）
  assert.strictEqual(
    kino.expandDetailUrl('<h2>鯊瘋了</h2>', '5239', 'https://kinostream.com'),
    'https://kinostream.com/cloud/play/5239'
  );
  const kDetail =
    '<html><head><script type="application/ld+json">' +
    '{"@type":"VideoObject","name":"鯊瘋了 Shark Frenzy - KINOSTREAM","description":"简介",' +
    '"thumbnailUrl":"https://flicksbank.console360.net/images/5239/default.jpg","actor":"某演员"}' +
    '</script></head><body><div class="movie_box_inner"><h5>級別 | 輔導十五歲級</h5></div></body></html>';
  const kPlay =
    '<html><body><script>player.load("https://mdc-garageplay.cdn.hinet.net/x/playlist.m3u8?token=abc&expires=1");</script></body></html>';
  const kD = kino.parseDetail(kDetail, '5239', kPlay);
  assert.strictEqual(kD.title, '鯊瘋了 Shark Frenzy');
  assert.strictEqual(kD.genreName, '輔導十五歲級');
  assert.strictEqual(kD.sources[0].src, 'https://mdc-garageplay.cdn.hinet.net/x/playlist.m3u8?token=abc&expires=1');
  assert.strictEqual(kD.episodes[0].url, 'https://mdc-garageplay.cdn.hinet.net/x/playlist.m3u8?token=abc&expires=1');
  // 无 m3u8（非放行出口）：元数据照出，选集为空
  const kD2 = kino.parseDetail('<html><body><h2>某片</h2></body></html>', '1');
  assert.strictEqual(kD2.title, '某片');
  assert.strictEqual(kD2.episodes.length, 0);

  // 11. netflixgc 适配器（AppleCMS 站：分类 POST JSON / 搜索服务端渲染 / 选集 id-sid-nid 懒解析）
  const nfx = require('../src/sites/netflixgc');
  assert.strictEqual(nfx.key, 'netflixgc');
  assert.strictEqual(nfx.redirectM3u8, true);
  assert.strictEqual(nfx.noCachePlayHtml, true);
  assert.strictEqual(nfx.CATS.length, 12);
  assert.strictEqual(nfx.catById(2).type_name, '连续剧');
  // 搜索走 GET 渲染页
  assert.strictEqual(
    nfx.buildSearchUrl({ query: '鬼谜', pg: 2 }, 'https://www.netflixgc.com'),
    'https://www.netflixgc.com/vodsearch/%E9%AC%BC%E8%B0%9C----------2---.html'
  );
  // 分类走 POST JSON（框架 fetchListHtml 识别 {url, post}）
  const nfxListReq = nfx.buildSearchUrl({ genre: '2', sort: '', pg: 1 }, 'https://www.netflixgc.com');
  assert.strictEqual(nfxListReq.url, 'https://www.netflixgc.com/index.php/ds_api/vod');
  assert.ok(String(nfxListReq.post).includes('type=2'), JSON.stringify(nfxListReq));
  assert.ok(String(nfxListReq.post).includes('by=time'), JSON.stringify(nfxListReq));
  assert.ok(String(nfx.buildSearchUrl({ genre: '2', sort: 'hits', pg: 3 }, 'https://www.netflixgc.com').post).includes('by=hits'));
  // JSON 列表解析
  const nfxJson = JSON.stringify({
    code: 1, pagecount: 453, total: 18095,
    list: [
      { vod_id: 119030, vod_name: '鬼谜东宫', vod_pic: 'https://x/119030.jpg' },
      { vod_id: 119058, vod_name: '幸运女神', vod_pic: '' },
    ],
  });
  const nfxItems = nfx.parseList(nfxJson);
  assert.strictEqual(nfxItems.length, 2);
  assert.strictEqual(nfxItems[0].vid, '119030');
  assert.strictEqual(nfxItems[0].title, '鬼谜东宫');
  assert.strictEqual(nfxItems[0].pic, 'https://x/119030.jpg');
  assert.strictEqual(nfx.parsePageCount(nfxJson, 1), 453);
  // 搜索 HTML 解析 + 分页
  const nfxSearchHtml =
    '<div class="vod-detail search-list"><div class="detail-pic"><img data-src="https://x/a.jpg" src="data:image/gif;base64,xx"></div>' +
    '<div class="detail-info"><a href="/voddetail/119030.html"><h3 class="slide-info-title">鬼谜东宫</h3></a></div></div>' +
    '<div class="page-tip">共6855条数据,当前1/686页</div>';
  const nfxSearch = nfx.parseList(nfxSearchHtml);
  assert.strictEqual(nfxSearch.length, 1);
  assert.strictEqual(nfxSearch[0].vid, '119030');
  assert.strictEqual(nfxSearch[0].pic, 'https://x/a.jpg');
  assert.strictEqual(nfx.parsePageCount(nfxSearchHtml, 1), 686);
  // detailUrl 双模
  assert.strictEqual(nfx.detailUrl('119030', 'https://www.netflixgc.com'), 'https://www.netflixgc.com/voddetail/119030.html');
  assert.strictEqual(nfx.detailUrl('119030-1-2', 'https://www.netflixgc.com'), 'https://www.netflixgc.com/vodplay/119030-1-2.html');
  // 播放页解密（encrypt=2）
  const nfxM3u8 = 'https://cdn.example.com/x/index.m3u8';
  const nfxEnc = Buffer.from(encodeURIComponent(nfxM3u8).replace(/'/g, '%27'), 'utf8').toString('base64');
  assert.strictEqual(nfx.decryptPlayerUrl(nfxEnc, 2), nfxM3u8);
  assert.strictEqual(nfx.decryptPlayerUrl(nfxM3u8, 0), nfxM3u8);
  const nfxPlayPage = `<div class="MacPlayer"><script>var player_aaaa={"flag":"play","encrypt":2,"vod_data":{"vod_name":"鬼谜东宫"},"url":"${nfxEnc}","from":"bfzym3u8","id":"119030","sid":1,"nid":2}</` + `script></div>`;
  const nfxEp = nfx.parseDetail(nfxPlayPage, '119030-1-2');
  assert.strictEqual(nfxEp.sources[0].src, nfxM3u8);
  assert.strictEqual(nfxEp.episodes[0].url, nfxM3u8);
  // 详情页：元数据 + sid=1 选集盒
  const nfxMeta =
    '<div class="detail-pic"><img data-src="https://x/cover.jpg"></div>' +
    '<h3 class="slide-info-title">鬼谜东宫</h3>' +
    '<div class="slide-info"><strong>演员 :</strong><a>南柱赫</a><span>,</span><a>卢允瑞</a></div>' +
    '<div class="vod-tag"><a>#鬼谜东宫</a><a>#恐怖</a></div>' +
    '<div id="height_limit">简介文字</div>' +
    '<div class="anthology-list-box"><ul><li><a href="/vodplay/119030-4-1.html">1</a></li></ul></div>' +
    '<div class="anthology-list-box"><ul><li><a href="/vodplay/119030-1-1.html">第1集</a></li>' +
    '<li><a href="/vodplay/119030-1-2.html">第2集</a></li></ul></div>';
  const nfxD = nfx.parseDetail(nfxMeta, '119030', nfxPlayPage);
  assert.strictEqual(nfxD.title, '鬼谜东宫');
  assert.strictEqual(nfxD.pic, 'https://x/cover.jpg');
  assert.strictEqual(nfxD.actor, '南柱赫,卢允瑞');
  assert.deepStrictEqual(nfxD.tags, ['鬼谜东宫', '恐怖']);
  assert.strictEqual(nfxD.episodes.length, 2, JSON.stringify(nfxD.episodes));
  assert.strictEqual(nfxD.episodes[0].vid, '119030-1-1', '必须选中 sid=1 默认线路');
  assert.strictEqual(nfxD.sources[0].src, nfxM3u8, '二跳默认集直链给 /play?v=裸id 用');
  // 首页榜单：按 h4 分节
  assert.strictEqual(nfx.catById(101).type_name, '热播榜');
  const nfxBoardReq = nfx.buildSearchUrl({ genre: 'board:热播榜', pg: 1 }, 'https://www.netflixgc.com');
  assert.ok(String(nfxBoardReq).includes('?board='), nfxBoardReq);
  const nfxBoardHtml =
    '<div class="box-width"><div class="title"><div class="title-left"><h4>热播榜🔥</h4></div></div>' +
    '<div class="public-list-box"><a class="public-list-exp" href="/voddetail/80498.html" title="弗兰肯斯坦">' +
    '<img data-src="https://x/80498.jpg" src="data:image/gif;base64,xx"></a></div>' +
    '<div class="public-list-box"><a class="public-list-exp" href="/voddetail/80474.html" title="你旁观的罪">' +
    '<img src="https://x/80474.jpg"></a></div></div>' +
    '<div class="box-width"><div class="title"><div class="title-left"><h4>热搜榜🔥</h4></div></div>' +
    '<div class="public-list-box"><a class="public-list-exp" href="/voddetail/19621.html" title="怪奇物语第一季">' +
    '<img data-src="https://x/19621.jpg"></a></div></div>';
  const nfxHot = nfx.parseList(nfxBoardHtml, nfxBoardReq);
  assert.strictEqual(nfxHot.length, 2, JSON.stringify(nfxHot));
  assert.strictEqual(nfxHot[0].vid, '80498');
  assert.strictEqual(nfxHot[0].pic, 'https://x/80498.jpg');
  const nfxTop = nfx.parseList(nfxBoardHtml, 'https://www.netflixgc.com/?board=%E7%83%AD%E6%90%9C%E6%A6%9C');
  assert.strictEqual(nfxTop.length, 1);
  assert.strictEqual(nfxTop[0].vid, '19621');
  assert.strictEqual(nfx.parsePageCount(nfxBoardHtml, 3, nfxBoardReq), 3, '榜单单页，总页数恒为当前页');

  // 12. xhamster 适配器（Nuxt SSR + 原生 m3u8 直传）
  const xh = require('../src/sites/xhamster');
  assert.strictEqual(xh.key, 'xhamster');
  assert.strictEqual(xh.passthrough, true);
  assert.strictEqual(xh.CATS.length, 12);
  assert.strictEqual(xh.catById(1).genre, 'japanese');
  assert.strictEqual(
    xh.buildSearchUrl({ query: 'japanese', pg: 1 }, 'https://xhamster.com'),
    'https://xhamster.com/search/japanese'
  );
  assert.strictEqual(
    xh.buildSearchUrl({ query: 'japanese', pg: 3 }, 'https://xhamster.com'),
    'https://xhamster.com/search/japanese?page=3'
  );
  assert.strictEqual(
    xh.buildSearchUrl({ genre: 'asian', pg: 1 }, 'https://xhamster.com'),
    'https://xhamster.com/categories/asian'
  );
  assert.strictEqual(
    xh.buildSearchUrl({ genre: 'asian', pg: 2 }, 'https://xhamster.com'),
    'https://xhamster.com/categories/asian/2'
  );
  const xhListHtml =
    '<div class="video-thumb" data-video-id="7305747">' +
    '<a href="https://xhamster.com/videos/japanese-adult-story-7305747" aria-label="Japanese adult story">' +
    '<img src="https://ic-vt-nss.xhcdn.com/a/xxx/1280x720.232.jpg"></a>' +
    '<div data-role="video-duration-container"><div data-role="video-duration">10:41</div></div></div>' +
    '<div class="video-thumb" data-video-id="7305747">' +
    '<a href="https://xhamster.com/videos/japanese-adult-story-7305747">重复卡</a></div>';
  const xhItems = xh.parseList(xhListHtml);
  assert.strictEqual(xhItems.length, 1, JSON.stringify(xhItems));
  assert.strictEqual(xhItems[0].vid, 'japanese-adult-story-7305747');
  assert.strictEqual(xhItems[0].title, 'Japanese adult story');
  assert.ok(xhItems[0].pic.includes('1280x720.232.jpg'));
  assert.strictEqual(xh.parsePageCount('{"pagination":{"maxPages":2693}}', 1), 2693);
  assert.strictEqual(
    xh.detailUrl('japanese-adult-story-7305747', 'https://xhamster.com'),
    'https://xhamster.com/videos/japanese-adult-story-7305747'
  );
  const xhDetailHtml =
    '<html><head><meta property="og:title" content="Japanese adult story">' +
    '<meta property="og:image" content="https://ic-vt-nss.xhcdn.com/a/xxx/cover.jpg">' +
    '<meta property="og:description" content="Watch Japanese adult story porn. Starring: Aya Shiina. Category: Uncensored, Asian, Nude. Enjoy this XXX sex video and more!">' +
    '<link rel="preload" as="fetch" href="https://video-nss.xhcdn.com/abc,123/media=hls4/multi=256x144:144p:/007/305/747/_TPL_.av1.mp4.m3u8">' +
    '</head><body></body></html>';
  const xhD = xh.parseDetail(xhDetailHtml, 'japanese-adult-story-7305747');
  assert.strictEqual(xhD.title, 'Japanese adult story');
  assert.strictEqual(xhD.actor, 'Aya Shiina');
  assert.ok(xhD.tags.includes('Asian'), JSON.stringify(xhD.tags));
  assert.ok(xhD.sources[0].src.endsWith('.m3u8'));
  assert.strictEqual(xhD.episodes[0].url, xhD.sources[0].src);

  console.log('smoke OK: adapter + framework routes');
}

main().catch((e) => {
  console.error('smoke FAILED:', e);
  process.exit(1);
});
