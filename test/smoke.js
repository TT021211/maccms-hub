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

  // 6. missav 适配器
  const missav = require('../src/sites/missav');
  assert.strictEqual(missav.key, 'missav');
  assert.strictEqual(missav.passthrough, true);
  assert.strictEqual(missav.CATS.length, 13);
  assert.strictEqual(missav.catById(3).genre, '/uncensored-leak');
  assert.ok(
    missav.buildSearchUrl({ query: 'SSIS', pg: 1 }, 'https://missav.ai') ===
      'https://missav.ai/search/SSIS',
    missav.buildSearchUrl({ query: 'SSIS', pg: 1 }, 'https://missav.ai')
  );
  assert.ok(
    missav.buildSearchUrl({ genre: '/new', pg: 2 }, 'https://missav.ai').includes('page=2')
  );
  assert.strictEqual(
    missav.buildSearchUrl({ pg: 1 }, 'https://missav.ai'),
    'https://missav.ai/new'
  );

  // 分页熔断：虚高页码锁死在 pg+10，防无限翻页烧中转额度
  assert.strictEqual(missav.parsePageCount('<a href="?page=2000">末页</a>', 1), 11);
  assert.strictEqual(missav.parsePageCount('<a href="?page=5">5</a>', 1), 5);

  // parseList：混入导航/广告链接，只收番号卡（真实渲染 DOM：绝对地址 + Vue 属性）
  const missavListHtml = `
    <a href="https://missav.ai/dm539/new">最近更新</a>
    <a href="https://missav.ai/dm301/today-hot">今日熱門</a>
    <a href="/genres">類型</a>
    <a href="https://missav.ai/dldss-572"><img :class="{x:1}" data-src="https://fourhoi.com/dldss-572/cover-t.jpg" src="https://fourhoi.com/dldss-572/cover-t.jpg" alt="DLDSS-572 標題"></a>
    <a href="/dm14/pred-164-uncensored-leak"><img src="https://fourhoi.com/pred-164-uncensored-leak/cover-t.jpg"><span>PRED-164 標題</span></a>
    <a href="https://bit.ly/xyz">广告</a>
    <a href="#">top</a>`;
  const mItems = missav.parseList(missavListHtml);
  assert.strictEqual(mItems.length, 2, JSON.stringify(mItems));
  assert.strictEqual(mItems[0].vid, 'dldss-572');
  assert.strictEqual(mItems[0].pic, 'https://fourhoi.com/dldss-572/cover-t.jpg');
  assert.strictEqual(mItems[1].vid, 'pred-164-uncensored-leak');
  // 详情地址钩子
  assert.strictEqual(
    missav.detailUrl('dasd-542-uncensored-leak', 'https://missav.ai'),
    'https://missav.ai/dasd-542-uncensored-leak'
  );

  // parseDetail：字面 surrit 直链优先
  const dHtmlLit = `<html><head><meta property="og:title" content="DASD-542 标题 - MissAV"></head>
    <body><h1>fallback</h1><video><source src="https://surrit.com/abc/playlist.m3u8"></video></body></html>`;
  const dd1 = missav.parseDetail(dHtmlLit, 'dasd-542-uncensored-leak');
  assert.strictEqual(dd1.title, 'DASD-542 标题');
  assert.strictEqual(dd1.sources[0].src, 'https://surrit.com/abc/playlist.m3u8');
  assert.strictEqual(dd1.episodes[0].url, 'https://surrit.com/abc/playlist.m3u8');

  // parseDetail：脚本内 UUID → 拼 playlist（广告位 blob UUID 无 surrit 上下文，不会被误取）
  const dHtmlUuid = `<html><body>
    <iframe src="blob:https://missav.ai/723f72fb-a8bd-45e8-b06c-ab67ce8cb34a"></iframe>
    <script>var player={cdn:"surrit",uuid:"9eca65c0-66dc-44c9-9fb4-edf9a576146d",quality:"1080p"};</script>
    </body></html>`;
  const dd2 = missav.parseDetail(dHtmlUuid, 'x');
  assert.strictEqual(
    dd2.episodes[0].url,
    'https://surrit.com/9eca65c0-66dc-44c9-9fb4-edf9a576146d/playlist.m3u8'
  );

  // 6b. 中转排队：同一事件循环内串行化（RELAY_MAX_CONCURRENT=1 时验证 FIFO）
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
  const relayUrl = buildRelayUrl('https://missav.ai/dm539/new');
  assert.ok(
    relayUrl ===
      'http://api.scraperapi.com?api_key=testkey123&url=https%3A%2F%2Fmissav.ai%2Fdm539%2Fnew&render=true',
    relayUrl
  );
  delete process.env.SCRAPERAPI_KEY;
  assert.strictEqual(buildRelayUrl('https://missav.ai/'), null);
  if (prevKey !== undefined) process.env.SCRAPERAPI_KEY = prevKey;

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

  console.log('smoke OK: adapter + framework routes');
}

main().catch((e) => {
  console.error('smoke FAILED:', e);
  process.exit(1);
});
