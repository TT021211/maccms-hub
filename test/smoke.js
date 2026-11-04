'use strict';

/* 离线冒烟测试：node test/smoke.js（无需上游网络，exit code 非 0 即失败） */

const assert = require('assert');

async function main() {
  const hanime1 = require('../src/sites/hanime1');
  const tmpl = require('../src/sites/_template');

  // 1. 适配器元信息
  assert.strictEqual(hanime1.key, 'hanime1');
  assert.strictEqual(hanime1.CATS.length, 13);
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

  // 7. 中转 URL 拼装（离线断言，不发请求）
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

  console.log('smoke OK: adapter + framework routes');
}

main().catch((e) => {
  console.error('smoke FAILED:', e);
  process.exit(1);
});
