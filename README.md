# danmu_api · 自用版

基于 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) 的自用分支，保留自用配置和匹配规则，通过审核式同步跟进上游。仅维护 **NAS Docker Compose 部署**，镜像由 GitHub Actions 发布至 GHCR，不需要 Docker Hub 账户。

## 功能与文档

保留官方视频平台、韩剧 TV（hanjutv）、人人视频（renren）、规则匹配和缓存，以及配置、日志和缓存管理。已移除其余第三方弹幕源、360、本地弹幕、收藏、推送、接口调试、AI、Upstash 和云部署管理。具体配置以文档为准。

### 主要功能

- **搜索与自动匹配**：按文件名识别作品、年份、季号和集号，支持标题映射、季集修正及手动选择记忆；需要时通过 TMDB 辅助确认作品和分集。
- **多源弹幕**：默认启用腾讯、爱奇艺、优酷、芒果、B站，可配置来源顺序、多源合并与时间偏移。还支持咪咕、搜狐、乐视、红果、韩剧 TV、人人视频和巴哈姆特，需在 `SOURCE_ORDER` 中启用。
- **B站投稿补充**：UGC 指用户投稿视频。可通过 `BILIBILI_UGC_ENABLED` 开启投稿检索、匹配兜底和弹幕补充，默认关闭；不同剪辑版本的时间轴仍需核对。
- **过滤与显示**：支持屏蔽词、正则、当前作品演员/角色及作品名过滤、去重、简繁转换和渐变扩展。新配置默认包含纯数字、纯符号（含表情）整条屏蔽正则，可在 `BLOCKED_WORDS` 中编辑；已有配置可追加 `/^\s*\p{N}+(?:\s+\p{N}+)*\s*$/u` 和 `/^[\s\p{P}\p{S}\uFE0E\uFE0F\u200D]+$/u`。人物与作品过滤默认关闭；文字渐变需要播放器支持。
- **电影配音版本**：文件名标明普通话、国语、原声或原版时优先选择对应版本；未标明或属于双语、多音轨时，在当前命中来源内合并同片同年的普通版与原版正片弹幕，普通版包含未标语言的“正片”条目。字幕标记不作为音轨依据；预告、花絮不参与合并。沿用各来源时间戳，配音版与原版的剪辑时间差需使用已有偏移配置调整。
- **管理与缓存**：提供配置、匹配追踪、日志与缓存管理；查询快照可保存到本地文件或可选本地 Redis，普通搜索和弹幕缓存保存在内存。

### 快速导航

[首次部署](#nas-首次部署) · [播放器接入](#播放器接入) · [常用配置](#常用配置) · [已有部署迁移](#从已有部署迁移) · [日常更新](#日常更新) · [常见问题](#常见问题)

| 内容 | 文档 |
| --- | --- |
| 每个版本的功能、修复、风险 | [自用版本说明](SELF_USE_CHANGELOG.md) |
| 映射、过滤、鉴权、渐变弹幕 | [自用功能说明](docs/self-use-features.md) |
| 播放器渐变字段、绘制接入与降级 | [播放器渐变接入指南](docs/player-gradient-integration.md) |
| iOS / Android / PC 的通用模型、缓存与绘制接入 | [客户端通用渐变接入](docs/client-gradient-integration.md) |
| API、环境变量、弹幕来源 | [配置参考](docs/configuration.md) |
| 人物过滤的百度百科补充规则 | [百度百科人物补充](docs/person-filter-baidu.md) |
| 旧部署迁移、测试与回滚 | [部署说明](docs/deployment.md) |
| 上游同步、分支与发布流程 | [维护说明](docs/maintenance.md) |
| 历史变更 | [旧更新日志](CHANGELOG.md) |

## 镜像与版本

**代码、镜像、更新说明共用一个自用版本号。NAS 始终使用 `ghcr.io/xlmc/danmu_api:latest`。**

版本格式是 `xdanmu-v0.N`，从 `xdanmu-v0.1` 开始，后续按 `v0.2、v0.3…` 递增，不使用日期。main 更新后由 Actions 运行测试、构建并检查 `linux/amd64` 和 `linux/arm64` 镜像，成功后更新 latest 并发布同名更新说明。**构建或检查失败不会更新 latest，草稿和预留标签不代表成功发布。**

- **看版本与更新内容**：[GitHub Releases](https://github.com/xlmc/danmu_api/releases)，包含源码提交、变更摘要、镜像 digest 和构建链接。
- **看失败/进行中的构建**：[Actions](https://github.com/xlmc/danmu_api/actions/workflows/docker-image.yml)，摘要与附件保留当次状态。
- **写功能说明**：[自用更新日志](SELF_USE_CHANGELOG.md)，记录功能含义、配置变化、风险；Release 会链接到对应源码版本并带上增量。

上游版本仅说明代码基于哪个上游版本；Actions 运行编号、SHA、digest 是排错信息，不是需要维护的另一套版本号。新流程不再生成额外的 `build-*` 或 `sha-*` 镜像标签，已有历史镜像不删除。源码合并、镜像发布、NAS 升级分别确认；仓库不会自动升级 NAS。

## NAS 首次部署

> **已有部署请跳到下方迁移章节，不要用新模板覆盖原配置。** 以下均为通用示例，不包含真实主机地址、账号或宿主机路径。

1. 在 NAS 选择项目目录，保存 [compose.nas.yml](compose.nas.yml)。模板使用相对此文件的 `./data/config` 和 `./data/.cache`，分别挂载到 `/app/config` 和 `/app/.cache`。
2. 创建上述目录，将 [配置示例](config/.env.example) 保存为 `data/config/.env`。**启动前**设置自己的 `TOKEN`，不要使用默认令牌，也不要把真实配置提交到 Git。
3. 模板已设置 latest 镜像，不需要 `DANMU_API_IMAGE`。默认宿主端口为 `9321`；需要修改时，可在项目目录创建供 Compose 使用的 `.env`（与 `data/config/.env` 不是同一个文件）：

```dotenv
NAS_HTTP_PORT=9321
```

4. 在该目录执行（需要 Docker Compose v2 和 Docker 管理权限）：

```bash
docker compose -f compose.nas.yml config --quiet
docker compose -f compose.nas.yml pull
docker compose -f compose.nas.yml up -d
docker compose -f compose.nas.yml logs --tail=100
```

用 NAS 图形化项目管理时，导入同一模板并提供上述变量，确认相对挂载目录的实际解析位置。访问 `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>`，播放器和管理操作统一使用 `TOKEN`。容器默认端口为 `9321`；如设置了 `DANMU_API_PORT`，需相应调整映射。

保持鉴权开启，不要直接将 API 端口暴露到公网。配置、缓存数据和备份应仅保存在自己的设备上。

## 播放器接入

将下列占位内容替换为自己的 NAS 地址、宿主端口和令牌。播放器、配置修改、缓存清理和 Cookie 保存统一使用 `TOKEN`。

| 用途 | 地址 |
| --- | --- |
| 查看管理界面 | `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>` |
| 管理操作入口 | `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>` |
| 弹幕服务基础地址 | `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>` |
| 完整 API 前缀 | `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>/api/v2` |
| FongMi 兼容接口 | `http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>/api/v2/fongmi/danmaku` |

播放器若自动追加 `/api/v2`，填写基础地址；若要求完整 API 地址，填写完整前缀。具体字段以播放器的设置说明为准。

可用下面的请求检查搜索与文件名匹配。示例中的作品名和文件名可替换为实际内容：

```bash
curl --get 'http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>/api/v2/search/anime' \
  --data-urlencode 'keyword=作品名'

curl 'http://<NAS_IP>:<NAS_HTTP_PORT>/<TOKEN>/api/v2/match' \
  -H 'Content-Type: application/json' \
  --data '{"fileName":"作品名 S01E01"}'
```

搜索结果用于继续查询分集，匹配结果用于获取对应弹幕；完整接口及可选年份、类型、TMDB ID 参数见 [配置参考](docs/configuration.md)。

播放器可只传 TMDB ID 查询分集，例如：`/<TOKEN>/api/v2/search/episodes?tmdbId=300146&tmdbIdType=0&episode=1`。`tmdbIdType=0` 表示电视剧（默认），`1` 表示电影；`episode` 可传集数或 `movie`。服务通过 TMDB 详情解析标题后搜索弹幕源，认证沿用 `TMDB_API_KEY` 或现有代理/网关配置。解析失败返回空结果，同时传入 `anime` 时优先使用标题；返回的 `episodeId` 可用于后续 `/api/v2/comment/:episodeId` 请求，映射沿用 NAS 现有文件或 Redis 缓存。

播放器共用搜索结果和弹幕输出流程。分集查询返回 NAS 通用剧集 ID，下载时使用相同 ID 查询目录；不再生成或恢复 Infuse 专用长 ID。未指定 `format` 时使用 `DANMU_OUTPUT_FORMAT`。升级后已保存旧长 ID 的客户端需要重新搜索并选择弹幕。

## 常用配置

首次启动以 [config/.env.example](config/.env.example) 为模板，后续可通过同一 TOKEN 入口调整配置。下面只列常用入口，完整格式见 [配置参考](docs/configuration.md)。

| 需求 | 配置项与说明 |
| --- | --- |
| 开启或调整来源 | `SOURCE_ORDER`：启用来源及排列顺序 |
| 优先匹配某些平台 | `PLATFORM_ORDER`：例如 `tencent&youku,bilibili`，先并发搜索腾讯和优酷，未匹配再查B站；平台须已启用 |
| 合并多个来源 | `MERGE_SOURCE_PAIRS` / `CUSTOM_MERGE_RULES`：`PLATFORM_ORDER` 中的 `&` 只控制并发，不会开启合并 |
| 修正作品名、季号和集号 | `TITLE_MAPPING_TABLE` / `AUTO_MATCH_MAPPING_TABLE`：本机规则优先；远程映射默认关闭，填写对应 `_URL` 后启用 |
| 补充B站投稿弹幕 | `BILIBILI_UGC_ENABLED=true`：启用后检索并校验投稿，主源弹幕充足时跳过补充 |
| 过滤弹幕内容 | `BLOCKED_WORDS`；人物与作品过滤共用 `BLOCK_DOMESTIC_CELEBRITIES`，可用 `PERSON_FILTER_EXCLUDED_TITLES` 排除指定作品 |
| 修正弹幕时间 | `DANMU_OFFSET`：正数延后、负数提前，可按作品、季、集和来源设置 |
| 开启渐变扩展 | `GRADIENT_ENABLED` 与 `GRADIENT_CHANCE`：需同时启用并设置概率，播放器绘制方式见接入指南 |
| 查看详细匹配过程 | `LOG_LEVEL=debug`：排查后可恢复 `info`，减少逐请求日志 |

`data/config/.env` 是服务配置；Compose 项目目录下的 `.env` 用于 `NAS_HTTP_PORT` 等模板变量，两者用途不同。

## 从已有部署迁移

**迁移的最小改动是：原 Compose 只替换 `image`，其余设置保持不变。** 不需要等待上游合并 PR，也不需要迁移至 Docker Hub。

1. 记录旧镜像 ID/digest，保留旧镜像、原 Compose 和环境配置；停止写入后备份配置与全部持久化数据，本地 Redis 等存储另行备份。
2. 拉取本仓库的 latest 镜像，将备份复制到独立测试目录，用独立端口和独立项目名测试。**不得与生产共享可写挂载**，有外置存储也要隔离。
3. 验证鉴权、搜索/匹配、弹幕获取、分片和缓存恢复后，停止测试容器和旧生产容器。
4. 仅将原 Compose 中该服务的 `image` 改为 `ghcr.io/xlmc/danmu_api:latest`，保留原端口、绝对挂载路径、环境变量、网络和重启策略，拉取后在原项目内重建该服务。
5. 检查日志和播放器调用；失败时停止新容器，用旧镜像和升级前的数据备份回滚。

完整操作与回滚要求见 [迁移指南](docs/deployment.md)。仓库上游同步及镜像发布**不会自动更新 NAS**。

## 日常更新

镜像名称始终使用 latest，不必每次修改 Compose。备份后，在原项目目录执行（以下以仓库模板为例）：

```bash
docker compose -f compose.nas.yml pull danmu-api
docker compose -f compose.nas.yml up -d --no-deps danmu-api
docker compose -f compose.nas.yml logs --tail=100 danmu-api
```

只有拉取成功后才继续重建。`pull` 只下载镜像，`up -d` 才应用更新；仅 `restart` 不会换用新镜像。**使用 latest 不等于自动更新容器**，本仓库不额外安装定时更新服务。若旧 Compose 文件名或服务名不同，使用原来的名称和项目参数。

## 常见问题

**页面打不开或接口提示鉴权失败？** 先检查容器日志、端口映射和网络连通性，再确认 URL 第一段使用自己的 `TOKEN`。查看页面、执行管理操作与播放器请求使用同一个令牌。

**搜索有结果，自动匹配却失败？** 核对播放器实际提交的文件名、年份、季号和集号，以及来源是否启用。自动匹配会校验作品和分集身份，不能确认时会保持未匹配；可先手动选择，再按需添加标题或季集映射。匹配追踪与 `debug` 日志可帮助定位。

**设置了平台并发，为什么没有合并弹幕？** `PLATFORM_ORDER` 控制搜索顺序，合并需另设 `MERGE_SOURCE_PAIRS` 或 `CUSTOM_MERGE_RULES`。自动匹配只合并当前组已搜索的来源，需要合并的来源应放在同一组。

**重启后弹幕缓存消失？** 普通搜索和弹幕缓存仅保存在内存。挂载 `./data/.cache` 保存的是查询快照等数据，不是完整弹幕内容；文件缓存还需 `LOCAL_CACHE_ENABLED=true`。

**开启渐变后仍显示单色？** 服务输出渐变扩展字段，但文字绘制由播放器实现。未支持扩展的播放器使用兼容颜色；XML 仍输出单色，详见 [播放器渐变接入指南](docs/player-gradient-integration.md)。

**拉取 latest 后版本没有变化？** 确认拉取成功并执行 `up -d` 重建容器，`restart` 不会应用新镜像。再检查 [发布记录](https://github.com/xlmc/danmu_api/releases) 和 [构建状态](https://github.com/xlmc/danmu_api/actions/workflows/docker-image.yml)，构建失败不会更新 latest。

## 开发与维护

```bash
npm install --no-audit --no-fund
npm test
```

上游更新进入同步分支和 PR，审核后才合入 main；功能分支是否可删除需核对独有提交及开放 PR，详见维护说明。自动测试不代表所有远程弹幕源、播放器或 NAS 生产升级已实测。

项目沿用上游代码及许可，用于学习和自用。请勿在公开文档、Issue、日志或版本说明中提交私人地址、路径、令牌与账户配置。
