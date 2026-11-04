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

  console.log('smoke OK: adapter + framework routes');
}

main().catch((e) => {
  console.error('smoke FAILED:', e);
  process.exit(1);
});
