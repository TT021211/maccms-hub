# maccms-hub 交接文档（线上在用）

把任意刮削站实时转成 **MacCMS V10 `provide/vod` 采集接口** + **HLS 播放链路**，
供 MoonTVPlus（`tv.acxou.hair`，镜像 `ghcr.io/tt021211/moontvplus:latest`，含 `/hanime` 里番频道）聚合搜索与播放。

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
| `src/server.js` | 通用核心：路由/缓存/MacCMS 信封/`/play`/ffmpeg HLS，多站共存 |
| `src/sites/hanime1.js` | hanime1 适配器（13 分类 + 解析，行为与老服务一致） |
| `src/sites/_template.js` | 新站模板（复制填空，见第 8 节） |
| `test/smoke.js` | 离线冒烟测试（`npm test`）：适配器解析 + 路由回归 |
| `Dockerfile` | `node:20-alpine` + `ffmpeg`，`npm ci --omit=dev`（**必须同时 COPY package.json + package-lock.json**） |
| `docker-compose.yml` | 示例（VPS 上以第 4 节的实际文件为准） |
| `.github/workflows/docker-image.yml` | push 即云构建 GHCR |

环境变量：`PORT`（3001）、`DEFAULT_SITE`（`hanime1`，无前缀地址走它）、
`<KEY>_BASE`（如 `HANIME_BASE`）、`CACHE_TTL`（默认 7200）、
`PUBLIC_BASE_<KEY>`（如 `PUBLIC_BASE_HANIME1=https://hanime1.acxou.hair`，不设则回退 watch 页）、
`HLS_DIR`（默认 `/tmp/hls`）、`HLS_MAX_GB`（默认 8）、`SCRAPERAPI_KEY`
（只给开 `useRelay` 的 CF 站用，如 missav；hanime1 等直连站不受影响）。

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

MoonTVPlus 侧（镜像 `ghcr.io/tt021211/moontvplus:latest`，fork 自建 `/hanime` 频道，
代码在 `https://github.com/TT021211/MoonTVPlus`）：

```
源管理 → 自定义源：key: hanime1, api: http://maccms-hub:3001/hanime1/api.php/provide/vod
后台打开「禁用黄色过滤器」（环境变量 NEXT_PUBLIC_DISABLE_YELLOW_FILTER=true，
否则 Cosplay 分类会被黄词表杀掉）
```

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

## 7. 加一个新站（5 分钟）

1. 复制 `src/sites/_template.js` → `src/sites/xxx.js`，填 `key/CATS/buildSearchUrl/parseList/parseDetail`
   （key 只能 `[a-z0-9-]`，见第 6.6 条）。
2. 本地 `npm test`（离线冒烟；有 fixture 就顺手加断言）。
3. `git push` → Action 绿 → VPS `docker compose pull && docker compose up -d`。
4. MoonTV 后台加源：`api: http://maccms-hub:3001/xxx/api.php/provide/vod`。
5. 内网验证：`.../xxx/api.php/provide/vod/?ac=list&t=1&pg=1` 有 `list[].vod_play_url` 且以 `.m3u8` 结尾。
