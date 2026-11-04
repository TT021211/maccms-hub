# maccms-hub 采集网关

把任意刮削站实时转成 **MacCMS V10 `provide/vod` 接口** + **HLS 播放链路**，
供 MoonTVPlus 聚合搜索与播放。一个容器带 N 个站，新站只加一个适配器文件。

## 1. 链路

```
上游站 ──刮削──▶ maccms-hub:3001 ──内网http──▶ moontv-core ──▶ 浏览器
                    │  HLS /h/<site>/<vid>/index.m3u8 (ffmpeg -c copy 转封装)
浏览器 ──HTTPS──▶ nginx-proxy:443 ──▶ maccms-hub:3001
```

## 2. 地址形态（`<site>` = 站点 key，如 `hanime1`）

| 功能 | 请求 |
|---|---|
| 分类列表 | `GET /hanime1/api.php/provide/vod/?ac=list&t=4&pg=1` |
| 搜索 | `GET /hanime1/api.php/provide/vod/?ac=list&wd=关键词&pg=1` |
| 详情/批量 | `GET /hanime1/api.php/provide/vod/?ac=detail&ids=115211,408484`（限 20 个） |
| mp4 直链 | `GET /play?site=hanime1&v=VID`（302；`?format=json` 看三档） |
| HLS | `GET /h/hanime1/<vid>/index.m3u8` + 切片 |
| 健康 | `GET /health` |

无前缀老地址（`/api.php/provide/vod/...`、`/play?v=`、`/h/<vid>/...`）自动走
`DEFAULT_SITE`（默认 `hanime1`），老 MoonTV 配置迁移零改动。
HLS 切片目录：默认站沿用 `/tmp/hls/<vid>`（已缓存的不用重切），其他站
`/tmp/hls/<site>/<vid>`。

## 3. 加一个新站（5 分钟）

1. 复制 `src/sites/_template.js` → `src/sites/xxx.js`，填 `key/CATS/buildSearchUrl/parseList/parseDetail`。
2. `docker build` 或等云构建，VPS `pull + up -d`。
3. MoonTV 后台加源：`api: http://maccms-hub:3001/xxx/api.php/provide/vod`。
4. 内网验证：`.../xxx/api.php/provide/vod/?ac=list&t=1&pg=1` 有 `list[].vod_play_url` 且以 `.m3u8` 结尾。

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 默认 3001 |
| `DEFAULT_SITE` | 无前缀地址走哪个站，默认 `hanime1` |
| `<KEY>_BASE` | 如 `HANIME_BASE`，上游站基地址 |
| `CACHE_TTL` | 列表/详情缓存秒数，默认 7200 |
| `PUBLIC_BASE_<KEY>` / `PUBLIC_BASE` | 拼 HLS 选集用的公网地址，不设则回退 watch 页 |
| `HLS_DIR` / `HLS_MAX_GB` | 切片目录/上限，默认 `/tmp/hls` / 8 |

## 5. 文件清单

| 文件 | 说明 |
|---|---|
| `src/server.js` | 通用核心：路由/缓存/MacCMS 信封/`/play`/ffmpeg HLS |
| `src/sites/hanime1.js` | hanime1 适配器（13 分类 + 解析，行为与老服务一致） |
| `src/sites/_template.js` | 新站模板 |
| `test/smoke.js` | 离线冒烟测试（`npm test`） |
| `Dockerfile` | `node:20-alpine` + `ffmpeg` |
| `.github/workflows/docker-image.yml` | push 即云构建 `ghcr.io/tt021211/maccms-hub`（amd64+arm64） |
