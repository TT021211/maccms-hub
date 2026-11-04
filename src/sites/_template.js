'use strict';

/**
 * 站点适配器模板：新刮削站复制本文件为 `<sitekey>.js`，把 TODO 逐项填完即可。
 * 框架（src/server.js）只依赖本文件 module.exports 的字段，不碰站点细节。
 *
 * 接入 MoonTV 后的地址形态：
 *   列表: GET /<sitekey>/api.php/provide/vod/?ac=list&t=1&pg=1
 *   搜索: GET /<sitekey>/api.php/provide/vod/?ac=list&wd=关键词&pg=1
 *   详情: GET /<sitekey>/api.php/provide/vod/?ac=detail&ids=ID1,ID2
 *   播放: GET /play?site=<sitekey>&v=VID  (302 到最高清晰度；?format=json 看三档)
 *   HLS:  GET /h/<sitekey>/<vid>/index.m3u8
 */

const cheerio = require('cheerio'); // eslint-disable-line

module.exports = {
  // TODO(必填): 全局唯一小写 key，只能含 [a-z0-9-]，会出现在 URL 路径里
  key: 'example',

  // TODO(必填): 站点展示名（MoonTV 源管理里看到的名字就用这个）
  displayName: 'Example',

  // 上游站基地址：从环境变量读，默认写死，二选一即可
  baseEnv: 'EXAMPLE_BASE',
  defaultBase: 'https://example.com',

  // 拼 vod_play_url 用的公网地址（HLS 用；不设则回退到上游站 watch 页，只能跳转不能播）
  // 支持 `PUBLIC_BASE_<KEY大写>`，也兼容全局 `PUBLIC_BASE`
  publicBaseEnv: 'PUBLIC_BASE_EXAMPLE',

  // 自定义 UA（反爬用）：如需指定则填 env 名，否则删掉本行
  uaEnv: 'EXAMPLE_UA',

  // TODO(必填): 分类表。type_id 会原样透传给 `?t=`，MoonTV 频道页直接拿它当 tab
  CATS: [{ type_id: 1, type_name: '示例分类', genre: '', sort: '' }],

  // 按 type_id 找分类（一般不用改；支持 ?t=中文名直传）
  catById(t) {
    return this.CATS.find((c) => String(c.type_id) === String(t));
  },

  // 请求头（Referer 必须带，大部分站防盗链就靠这个）
  headersFor(ua, base) {
    return {
      'User-Agent': ua,
      Referer: base + '/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
  },

  // TODO(必填): 把 (genre/sort/query/pg) 拼成上游列表/搜索页 URL
  buildSearchUrl({ genre = '', sort = '', query = '', pg = 1 }, base) {
    const p = new URLSearchParams();
    if (genre) p.set('genre', genre);
    if (sort) p.set('sort', sort);
    if (query) p.set('query', query);
    else p.set('query', '');
    p.set('page', String(pg));
    return `${base}/search?${p.toString()}`;
  },

  // TODO(必填): 从列表页 HTML 抠出 [{ vid, title, pic }]（vid 是上游站内唯一 ID）
  // 技巧：先在浏览器开发者工具里看卡片 DOM，再写选择器；标题取全称属性，防缩写
  parseList(html) {
    const $ = cheerio.load(html);
    const videos = [];
    const seen = new Set();
    $('a[href*="watch?v="]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/[?&]v=(\d+)/);
      if (!m || seen.has(m[1])) return;
      const title = ($(a).attr('title') || $(a).text() || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      seen.add(m[1]);
      videos.push({ vid: m[1], title, pic: '' });
    });
    return videos;
  },

  // TODO(选填): 解析总页数；解析不到就返回当前页（框架用它算 pagecount）
  parsePageCount(html, pg) {
    const m = String(html).match(/page=(\d+)/g);
    let max = pg;
    if (m) {
      for (const s of m) {
        const n = parseInt(s.split('=')[1], 10);
        if (!isNaN(n) && n > max && n < 10000) max = n;
      }
    }
    return max;
  },

  // TODO(必填): 从详情页 HTML 抠出标题/封面/直链/选集/tags
  // sources 必须按清晰度降序（框架拿 sources[0] 当最高清晰度做 /play 302）
  parseDetail(html, vid) {
    const $ = cheerio.load(html);
    return {
      title: ($('h1').first().text() || `video ${vid}`).replace(/\s+/g, ' ').trim(),
      pic: '',
      desc: '',
      actor: '',
      genreName: '',
      sources: [], // [{ size: 1080, src: 'https://...mp4' }]
      episodes: [{ name: '正片', vid: String(vid) }],
      tags: [],
    };
  },
};
