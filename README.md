# maccms-hub 交接文档（线上在用）

把任意刮削站实时转成 **MacCMS V10 `provide/vod` 采集接口** + **HLS 播放链路**，
供 MoonTVPlus（`tv.acxou.hair`，镜像 `ghcr.io/tt021211/moontvplus:latest`，
含 `/hanime` 里番 / `/missav` / `/aqdlt` 爱情岛 / `/hohoj` 四个频道）聚合搜索与播放。

仓库：`https://github.com/TT021211/maccms-hub`（Public；push 即云构建 `ghcr.io/tt021211/maccms-hub:latest`，amd64+arm64）

## 1. 链路总览

```
hanime1.me ──刮削──▶ maccms-hub:3001 ──内网http──▶ moontv-core ──▶ 浏览器
       │                │ /h/hanime1/<vid>/index.m3u8 (ffmpeg -c copy 转封装)
       │                └─ 无前缀老地址 → DEFAULT_SITE=hanime1（兼容）
       └──────── ffmpeg ┘
浏览器 ──HTTPS──▶ nginx-proxy:443 (hanime1.acxou.hair) ──▶ maccms-hub:3001
```

- 搜索/列表/详情走 **站内网 `http://maccms-hub:3001`**（同 `hanime1-net`，无 TLS、无公网绕行）。
- 浏览器播放走 **公网 `https://hanime1.acxou.hair`**（HLS）。
- MoonPlus 只收录 `.m3u8` 结尾的选集（源码写死），mp4 直链会被整条丢弃——这就是必须做 HLS 转封装的原因。

## 2. 文件清单（仓库 `maccms-hub/`）

| 文件 | 说明 |
|---|---|
| `src/server.js` | 通用核心：路由/缓存/MacCMS 信封/`/play`/ffmpeg HLS/中转排队，多站共存 |
| `src/sites/hanime1.js` | hanime1 适配器（13 分类 + 解析，行为与老服务一致） |
| `src/sites/missav.js` | MissAV 适配器（13 分类，surrit 原生 m3u8 直传 + `useRelay` 中转） |
| `src/sites/aqdlt.js` | 爱情岛适配器（13 分类，sojson 还原 + cdn.aqd-tv 原生 m3u8 直传） |
| `src/sites/hohoj.js` | HoHoJ 适配器（13 分类，iframe 二跳 `/embed` + ggjav 原生 m3u8 直传，720P） |
| `src/sites/_template.js` | 新站模板（复制填空，见第 8 节） |
| `test/smoke.js` | 离线冒烟测试（`npm test`）：适配器解析 + 路由回归 |
| `Dockerfile` | `node:20-alpine` + `ffmpeg`，`npm ci --omit=dev`（**必须同时 COPY package.json + package-lock.json**） |
| `docker-compose.yml` | 示例（VPS 上以第 4 节的实际文件为准） |
| `.github/workflows/docker-image.yml` | push 即云构建 GHCR |

环境变量：`PORT`（3001）、`DEFAULT_SITE`（`hanime1`，无前缀地址走它）、
`<KEY>_BASE`（如 `HANIME_BASE`）、`CACHE_TTL`（默认 7200）、
`PUBLIC_BASE_<KEY>`（如 `PUBLIC_BASE_HANIME1=https://hanime1.acxou.hair`，不设则回退 watch 页）、
`HLS_DIR`（默认 `/tmp/hls`）、`HLS_MAX_GB`（默认 8）、`SCRAPERAPI_KEY`
（只给开 `useRelay` 的 CF 站用，如 missav；hanime1/aqdlt 等直连站不受影响）、
`RELAY_MAX_CONCURRENT`（中转并发上限，默认 3，试用 key 并发低不要调大）。

## 3. 接口

基地址（内网）：`http://maccms-hub:3001`；公网：`https://hanime1.acxou.hair`

| 功能 | 请求 |
|---|---|
| 分类列表 | `GET /hanime1/api.php/provide/vod/?ac=list&t=4&pg=1` |
| 搜索 | `GET /hanime1/api.php/provide/vod/?ac=list&wd=关键词&pg=1` |
| 详情/批量 | `GET /hanime1/api.php/provide/vod/?ac=detail&ids=115211,408484`（限 20 个） |
| mp4 直链 | `GET /play?site=hanime1&v=VID`（302；`?format=json` 看三档） |
| HLS | `GET /h/hanime1/<vid>/index.m3u8` + 切片 |
| 健康 | `GET /health` |

无前缀老地址（`/api.php/provide/vod/...`、`/play?v=`、`/h/<vid>/...`）自动走默认站。
默认站 HLS 切片沿用老卷 `/tmp/hls/<vid>`（已缓存的不用重切）；其他站 `/tmp/hls/<site>/<vid>`。

`t` 对照（hanime1）：1最新里番 2最新上市 3最新上傳 4裏番 5泡麵番 6MotionAnime 7 3DCG
8 2.5D 9 2D動畫 10 AI生成 11 MMD 12 Cosplay 13 新番預告（也支持 `?t=裏番` 中文直传）。

## 3.5 各站形态一览

| 站 | 列表/详情 | 播放源 | 备注 |
|---|---|---|---|
| hanime1 | 直连抓取 | mp4 → `/h/` ffmpeg 转封装 | 老服务原样迁移 |
| missav | ScraperAPI render 中转（`useRelay`） | surrit 原生 m3u8 直传（`passthrough`） | 详情页内联脚本 UUID → `surrit.com/<UUID>/playlist.m3u8`；播放须开 MoonTV 源 proxyMode（surrit 只认 missav.ai Referer，见 6.12） |
| aqdlt 爱情岛 | 直连抓取（无 CF） | cdn.aqd-tv 原生 m3u8 直传（`passthrough`，单码率 480p） | 整站 sojson 混淆，先 vm 还原再解析；暂无站内搜索，频道页无搜索框；m3u8 无 CORS 头，须开 MoonTV 源 proxyMode |
| hohoj | 直连抓取（无 CF） | ggjav 原生 m3u8 直传（`passthrough`，单码率 720p） | 详情页是壳，真实地址在内嵌 `/embed?id=` 子页（框架 `expandDetailUrl` 自动跟进）；m3u8 自带 CORS 头，直连可播 |

直传站列表不带 `vod_play_url`（聚合搜索会被 MoonTV 按 `episodes.length>0` 过滤），
只走独立频道/源站寻片；详情自带 m3u8，播放页直连详情即可。

## 4. 部署（VPS 现状，`/opt/maccms-hub/docker-compose.yml`）

```yaml
services:
  maccms-hub:
    image: ghcr.io/tt021211/maccms-hub:latest
    # ...环境变量见第 2 节...
    networks:
      - maccms-net
    volumes:
      - hls-cache:/tmp/hls
networks:
  maccms-net:
    external: true
    name: hanime1-net          # 复用老网；moonplus 侧同样 external 挂载
volumes:
  hls-cache:
    external: true
    name: hanime1-maccms_hls-cache   # 复用老缓存卷，已切切片秒开
```

nginx（`/opt/nginx/conf.d/hanime1.acxou.hair.conf`）：`proxy_pass http://maccms-hub:3001`。
改完 `docker exec nginx-proxy nginx -t && docker exec nginx-proxy nginx -s reload`。
证书沿用老流程（`certbot --config-dir /opt/nginx/certbot/conf`，见老文档）。

MoonTVPlus 侧（镜像 `ghcr.io/tt021211/moontvplus:latest`，fork 自建 `/hanime` `/missav`
`/aqdlt` `/hohoj` 四个频道，代码在 `https://github.com/TT021211/MoonTVPlus`）：

```
源管理 → 自定义源：
  key: hanime1, api: http://maccms-hub:3001/hanime1/api.php/provide/vod
  key: missav,  api: http://maccms-hub:3001/missav/api.php/provide/vod   + 开 proxyMode
  key: aqdlt,   api: http://maccms-hub:3001/aqdlt/api.php/provide/vod     + 开 proxyMode
  key: hohoj,   api: http://maccms-hub:3001/hohoj/api.php/provide/vod
后台打开「禁用黄色过滤器」（环境变量 NEXT_PUBLIC_DISABLE_YELLOW_FILTER=true，
否则 Cosplay 分类会被黄词表杀掉）
```

missav 必须开 proxyMode：surrit 只认 `https://missav.ai/` 的 Referer，
播放走本站 `/api/proxy/vod/m3u8` 中转（`UPSTREAM_REFERER_OVERRIDE` 已配好）。
aqdlt 也必须开：cdn.aqd-tv 的 m3u8 不带 CORS 头，浏览器直连被拦（分片 200 但无 ACAO）。
hohoj 不用开：ggjav 自带 `Access-Control-Allow-Origin: *`，直连可播。

## 5. 日常运维

```bash
docker logs maccms-hub --tail 20      # 应有 [maccms-hub] listening :3001 sites=hanime1
docker logs maccms-hub -f --tail 5    # 实时请求：site/ac/t/pg/wd + 条数 + 耗时
docker exec moontv-core wget -qO- --timeout=30 "http://maccms-hub:3001/hanime1/api.php/provide/vod/?ac=list&t=4&pg=1" | head -c 200
docker exec moontv-core wget -qO- --timeout=300 "http://maccms-hub:3001/h/hanime1/408844/index.m3u8" | head -c 200
```

- 更新流程（VPS 1G 内存**不要本地 build**）：本地改完 `npm test` → `git push` →
  Action 绿了 → `docker compose pull && docker compose up -d`。
- GHCR 包必须是 Public，否则 `pull` 报 denied（Packages 设置页改）。
- MoonPlus 搜不到时先看本服务日志有没有新的 `GET ... wd=xxx` 行：
  有 = 我们给了数据，问题在 MoonPlus 侧（过滤/缓存）；没有 = 请求没过来（配置/网络/缓存）。
- MoonPlus 搜索有 10 分钟内存缓存 + `cache_time` 小时级缓存，改完配置搜不到先**后台点清除缓存 /
  `docker restart moontv-core`** 再试。

## 6. 踩过的坑（复发时对照）

1. **hanime1 403**：对 `Chrome/124` UA 做 CF 指纹拦截。服务内建多 UA 轮换，403/503 自动换 UA 重试。
2. **endpoint 已存在**：老的手动 `docker network connect hanime1-net moontv-core` 残留 endpoint
   会让 `compose up` 报 `already exists`。先 `docker network disconnect hanime1-net moontv-core` 再 `up`。
   现在两边 compose 都用 `external: true` 挂网，不用再手连。
3. **空卷陷阱**：compose 里写短名 `hls-cache:` 会新建空卷（`maccms-hub_hls-cache`），切片全重切。
   必须 `external` 指回老卷（`hanime1-maccms_hls-cache`）。`docker volume ls | grep hls` 确认。
4. **GHCR 403 denied**：fork 里 workflow 写死了官方命名空间。教训：本仓库及 MoonTVPlus 的
   workflow 必须指向 `tt021211`，`lite` 那份也一样（曾因此失败一次）。
5. **`npm ci` 失败 exit 1**：`npm ci` 必须同时看到 `package.json + package-lock.json`。
   Dockerfile 里 `COPY package.json package-lock.json ./` 两份都要拷（曾因此失败一次）。
6. **`:site` 路由吞掉老地址**：`/:site` 无约束时会把 `/api.php/...` 的 `api.php` 当站点名。
   已收紧为 `:site([a-z0-9-]+)`（`src/server.js` + `test/smoke.js` 回归断言）。新站 key 只能用小写+数字+连字符。
7. **黄词误杀**：`Cosplay` 命中黄词表（`cms-proxy` 走 toLowerCase）。全站 `DisableYellowFilter=true` 躲过；
   以后加新站先拿分类名对 `yellow.ts` 过一遍 `includes`。
8. **搜不到结果**：MoonPlus 按 `endsWith(".m3u8")` + `episodes.length>0` 过滤。列表必须自带 m3u8 选集；
   与黄词表无关时先对 `wd=原神` 这类中性词。
9. **播放 502**：几乎都是 ffmpeg 拿不到 mp4（已带 `Referer`）或编码奇葩（已自动降级 `-c:a aac` 重试）。
   看 `[hls]` 日志原文。
10. **搜XX无结果但别的词有**：先看我们日志回了几条——回 N 条但前台无 = 被 MoonPlus 侧过滤；
    回 0 条 = 站内真没有或关键词被输入法搞错。
11. **missav（2026-11-04 已打通，走 ScraperAPI render 中转）**：VPS 直连被 CF 拦截，
    实测 UA 轮换 ❌ / TLS 伪装 ❌ / AnySearch 提取 ❌，仅 `render=true` 真渲染通过
    （列表 198K / 详情 328K，UUID 与 surrit seek 图双印证）。
    网关 `fetchHtml` 支持 `useRelay`（`sites/missav.js` 已开，需 `SCRAPERAPI_KEY`，按次计费，
    2 小时缓存挡重复），hanime1 等直连站零影响。ThisAV 系域名同期已被 JAV Anti-Piracy
    Project 没收，不用再试。
12. **missav 播放链路**：详情页 UUID → surrit m3u8 直传，但 surrit 只认
    `https://missav.ai/` 的 Referer（curl 实测：自己/空 Referer 403，missav 的 200），
    浏览器直连必被拦。解法：MoonTV 源开 proxyMode，播放走本站 `/api/proxy/vod/m3u8`
    中转，服务端带正确 Referer 去拿（`UPSTREAM_REFERER_OVERRIDE`，m3u8/segment/key
    三处共用）。另：MoonTV 详情接口默认 10 秒超时，中转一次 24~48 秒必被 abort
    （`{"error":"This operation was aborted"}`），已提到 120 秒（`downstream.ts`）。
13. **aqdlt sojson 整站混淆（2026-11-05 打通）**：列表/详情 HTML 全是反转字符串载荷 +
    解码桩 `document.write` 还原。网关用 Node vm 跑站点自己的解码器（只给 document 桩，
    无网络/定时器，5 秒超时），还原后再 cheerio 解析，模板已沉淀（`_template.js` 进阶钩子）。
    附带三个小坑：① 标题在 `<a>` 的 `alt` 属性里（不是 `title`），多候选取最长；
    ② 同一视频两个 `<a>`（缩略图卡 + 标题行），按 vid 合并；③ 封面 `src` 是占位图，
    真图在 `data-src/data-original`，优先取，跳过 4135 占位图。
14. **aqdlt 只有 480p**：ffprobe 实测单码率 `720×480` H.264+AAC，无高清档。能量大管饱，
    画质党当备用源。另：本站暂无站内搜索，`buildSearchUrl` 遇到 `wd` 直接抛错，
    频道页不设搜索框（聚合搜索天然过滤直传站，只走频道/寻片）。
15. **dispatch 兜底（2026-11-05）**：适配器抛错（如 aqdlt 拒搜）曾直接掀翻网关进程
    （Express 4 不收 async rejection → unhandledRejection → 退出，`RestartCount` 连涨）。
    现 dispatchWith 同步 try/catch + 异步 `.catch()` 转 502 JSON，单站报错只影响当次请求。
    教训：任何适配器逻辑都不许假设成功，框架层必须兜底。
16. **Docker 网络分裂（2026-11-05）**：磁盘写满那次把网络状态库写坏，出现
    `docker exec nginx-proxy wget maccms-hub` 报 `bad address`，但 `network connect`
    返回成功。确诊：`docker inspect maccms-hub` 显示 endpoint 的 `IPAddress:""` 为空
    （僵尸 endpoint）。解法：`docker network disconnect -f hanime1-net maccms-hub`
    → `docker stop/rm maccms-hub` → `compose up -d` 重建拿新 IP，再两边 inspect 对账。
    教训：connect 返回 0 不等于连上了，以两边 inspect 为准。
17. **VPS 磁盘 19G 爆满（2026-11-05）**：转码写不进盘、拉镜像失败、daemon 行为异常都源于此。
    账单：hls-cache 4.8G（上限 8G，正常）+ `/var/swapfile` 4.1G（别动）+ 孤儿卷
    （已删 freellm/panwatch/lunatv 的，`docker volume ls` 对着删，注意 7f6d3b0c 是线上
    kvrocks 在用的随机名卷，删了播放记录全没）+ suwayomi 镜像 2.09G（不用就删）。
    `/var/lib/docker/rootfs` 3.2G 身份未明，先别动。结论：以后每月 `docker image prune -a`
    + `builder prune -af` 各一次；19G 盘是紧的，考虑加盘。

18. **HoHoJ 翻页双坑（2026-11-05，本地实测打通）**：① 站内翻页参数是 `p`
    （分页全是 `javascript:changePage(N)` 跳转，无码类 729 页），网关之前按 `page=` 发，
    2 页以后永远回第一页。`buildSearchUrl` 已改 `p=${pg}`。② `parsePageCount` 原来只认
    `共N页/?page=/page/`，在 hohoj 眼里恒等于当前页 → MoonTVPlus 侧 `page < pageCount`
    永假，下滑直接判死。已加 `changePage\((\d+)\)` 识别（上限 500）。
    验证：`t=2 pg=2` 回 20 条新数据、`pagecount:500`（之前 `pagecount:1`）。
    教训：新站先拿 `?ac=videolist&t=X&pg=2` 对新旧两页的 vod_id，有重复/页数不动就是翻页参数错了。
19. **HoHoJ 导航全量分类（2026-11-05）**：站内导航（`/extra_info` 的 nav_collapse）是个大标签库，
    12 个 `/main_ctg` 主题 + 约 570 个 `/ctg` 标签，之前只接了内置 13 个。现 `ensureNavCats`
    在列表/详情前把导航并进 CATS（24 小时缓存，失败回退内置；`server.js` 经可选钩子调用，
    不影响其他站）。动态 id：`main_ctg` 缺的 4 个 → `1000+N`，`ctg` 全量 → `2000+N`，
    与内置重复 path 的跳过。验证：`?ac=list` 回 586 个分类；`t=2011（巨乳）pg=1/2` 各 20 条
    且不重复。MoonTVPlus 侧零改动（分类/视频接口自动透出，频道胶囊行横滑浏览）。注意频道页
    胶囊一次渲染五百多个按钮，低端机首屏会重一点，可接受。

## 7. 加一个新站（5 分钟）

1. 复制 `src/sites/_template.js` → `src/sites/xxx.js`，填 `key/CATS/buildSearchUrl/parseList/parseDetail`
   （key 只能 `[a-z0-9-]`，见第 6.6 条）。
2. 本地 `npm test`（离线冒烟；有 fixture 就顺手加断言）。
3. `git push` → Action 绿 → VPS `docker compose pull && docker compose up -d`。
4. MoonTV 后台加源：`api: http://maccms-hub:3001/xxx/api.php/provide/vod`。
5. 内网验证：`.../xxx/api.php/provide/vod/?ac=list&t=1&pg=1` 有 `list[].vod_play_url` 且以 `.m3u8` 结尾。

## 8. MoonTVPlus 爆改记录（2026-11-05，仓库 `TT021211/MoonTVPlus`，与本网关联动）

- 主题：`src/app/mutefun-theme.css`（mutefun.tv 风：浅底 + 红橙主色），`layout.tsx` 挂载。
- 播放页：工具条只留下载/复制链接/App跳转/去广告/超分+选集；左右 26% 热区双击快退/快进；
  删推荐/豆瓣评论/AI评论/网盘弹窗/AI面板/快捷键弹窗。
- 黄色过滤默认开，搜索页“高级”下拉有前台开关（`?yellowFilter=`，6 个搜索/分类接口全支持）；
  R18 四频道专属路由 bypass —— VPS 上 `NEXT_PUBLIC_DISABLE_YELLOW_FILTER=true` 可以拿掉了。
- 自定义分类每行独立启用/禁用（后台本来就有，不用改）。
- 大删除：观影室/WebTV/直播/漫画/书/音乐/求片/AI/通知/离线下载/短剧等路由+API+组件
  （约 -5.6 万行），保留搜索/豆瓣/播放/收藏/下载/四频道；`admin` 后台没动。
- 通用自建源新建 `/browse` 页（源切换 + 真实 `?ac=list` 父/子分类 + 网格 + 去重收敛的下滑加载），
  导航“源浏览”；`api/source-search` 恢复（分类补 `?yellowFilter=`，videos 补 `pageCount` 兜底）。
- 联动：本网关 hohoj 翻页修复（见 6.18）必须 `push → VPS pull`，否则 HoHoJ 频道翻页还是死的。
