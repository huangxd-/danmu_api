# 自用仓库维护约定

## 目录只做必要整理

- `README.md`：自用版入口，不再混合完整上游手册与所有自用细节。
- `SELF_USE_CHANGELOG.md`：当前自用版本功能、修复、上游基线、镜像和部署状态。
- `CHANGELOG.md`：原有历史，保留但不把旧 Unreleased 当作已发布版本。
- `docs/self-use-features.md`：稳定的自用行为和配置说明。
- `docs/configuration.md`：从上游提取的 API/环境变量参考；不保留多平台部署教程，后续仅更新相关功能和配置。
- `docs/deployment.md`：GHCR 迁移、测试、备份、回滚。
- `compose.nas.yml`：唯一维护的部署模板；GHCR 构建仍使用 `Dockerfile`。
- 已移除 `vercel.json`、`netlify.toml`、`edgeone.json`、`wrangler.toml`、Netlify/EdgeOne 专用入口、`README.hf.md` 和 HF 同步工作流。
- `danmu_api/worker.js` 是 NAS `server.js` 也在调用的共享请求处理器，不能因文件名就删除。底层平台兼容 handler 和 Forward 客户端代码暂留以减少上游冲突，不代表维护其部署；本轮不重构这些业务依赖。

## 分支用途

`main` 用于通过验证的自用代码和 GHCR 发布。临时工作分支在 PR 合并后删除，不长期保留整理分支；NAS 运行不需要功能分支。

仍有关联开放 PR 或未合并独有提交的分支，不应仅因代码名字类似而删除。删除前核对关联 PR、提交差异并保存备份；私人备份路径和一次性分支审计记录不放入仓库。

## 自动同步上游

`Fork Sync` 工作流每天 UTC 00:00 / 北京时间 08:00 尝试同步，也可手动运行；定时任务可能延迟，并非准点保证。

1. 从自用 `origin/main` 开始，获取上游 `main`。
2. 上游已在 main 历史中：不创建重复提交/PR。
3. 没有冲突：创建保留双父历史的临时合并，运行 `npm test`，通过后推送到 `sync/upstream-main` 并创建/更新 PR。
4. 有冲突：中止临时合并，在专用分支保存上游快照，PR 写明冲突文件，需要手工解决；不自动选 ours/theirs。
5. 测试失败、网络错误、PR 权限错误：任务失败并给出提示；不更新 main，不部署 NAS。
6. 由你审阅 PR、补充版本说明并合并后，main 的 GHCR 流水线才构建新镜像。
7. 同步时保留 NAS-only 约定，不恢复已移除的云部署入口；上游修改被删除文件时会出现 modify/delete 冲突，需要人工判断。`npm test` 包含部署范围回归检查，防止已移除入口被静默带回。

专用分支使用 **force-with-lease** 防止覆盖获取之后发生的远程变化；仅用于 `sync/upstream-main`，绝不 force main。不要在该自动生成分支上长期手工开发；解决冲突请另开工作分支。

### 需要一次性确认的 GitHub 权限

默认使用 `GITHUB_TOKEN` 时，需要由仓库管理员在 **Settings → Actions → General → Workflow permissions** 开启 **Allow GitHub Actions to create and approve pull requests**；工作流只创建/更新 PR，不执行自动 approve。

同步脚本不自动修改仓库权限或生成 PAT。若组织策略不允许开启，可由你配置 `UPSTREAM_SYNC_TOKEN`（该仓库最小 Contents / Pull requests 写权限），工作流会优先使用它。不要将 token 写入仓库。

默认 GITHUB_TOKEN 创建 PR 不一定触发独立 PR 工作流，因此同步工作流自身会先执行回归测试；PR 中应查看该次 Fork Sync 日志。权限开通后，应手动运行一次验证，才能确认 PR 创建链路实际可用。

## 核心模块职责

| 模块 | 职责 |
| --- | --- |
| `worker.js` | 鉴权后的路由和请求限流 |
| `utils/request-auth.js`、`utils/request-context.js` | 单一 TOKEN 规则和请求身份隔离 |
| `apis/player-api.js` | 搜索、季集匹配、目录和匹配阶段预取 |
| `apis/comment-api.js` | 弹幕下载、缓存键、偏移、UGC 补充及最终过滤 |
| `sources/location.js` | URL 域名与原生来源 ID 解析 |
| `sources/registry.js` | 来源实例与元数据注册 |
| `utils/danmu-util.js` | 弹幕规范化及返回前的去重、数量限制和显示处理 |

弹幕缓存保存规范化数据，屏蔽词和人物过滤在每次返回时执行，显示处理排在过滤之后。并发来源下载只共享格式化原始数据，不共享请求的偏移。分段与整集使用不同缓存键；有作品偏移的整集还区分剧集上下文。`player-api.js` 保留弹幕接口导出以兼容现有调用，新调用可直接使用 `comment-api.js`。

## 自用发布流程

### 一个版本号，三个对应位置

`xdanmu-v0.N` 同时用于源码 Git 标签、GHCR 镜像标签和 GitHub Release；从 `xdanmu-v0.1` 开始自动递增，不使用日期。`latest` 是部署入口，不是另一个版本号；运行编号/重试次数仅保存在 Actions 中。

1. 功能/修复在 PR 中更新 `SELF_USE_CHANGELOG.md` 的“未发布”，记录入口、配置、行为、上游基线、风险和验证结果。
2. 工作分支运行 `npm test` 并检查 PR CI；审阅后合并 main。
3. main 自动运行发布工作流，预留唯一源码标签和 **Release 草稿**，执行测试。AMD64、ARM64 分别在对应架构的 GitHub runner 上构建并执行 Node.js/esbuild 冒烟测试，再按精确 digest 合成一个双架构版本镜像。默认部署标签暂不变化。
4. 通过镜像 digest 检查双架构清单，保存更新说明；确认 main 没有前进后才将该镜像提升为 latest，核对 latest 的 digest，最后公开同名 Release。
5. 在 [Releases](https://github.com/xlmc/danmu_api/releases) 查看每次成功版本。正文只展示本次更新内容，优先使用相对上次成功发布的自用更新日志新增条目；没有新增条目时使用提交说明。完整提交 SHA、文件统计、上游版本、镜像 digest 和构建状态保留在 Actions 摘要与附件的 `build-details.md`、`release-record.json` 中。
6. 按部署文档测试并手动升级 NAS。NAS 实际版本、备份和验收保存在私有运维记录，不公开个人部署信息。

**不再手动推标签触发另一轮构建，也不把发布结果提交回 main。** 因此不会出现“写更新说明 → 再构建 → 再写说明”的循环。Actions 创建标签/Release 使用本仓库的 `GITHUB_TOKEN`，需要 `contents: write`；推镜像需要 `packages: write`，不需要 Docker Hub 账号或新增 PAT。仓库策略如阻止标签/Release 写入，会报错而不是伪报成功。

### 失败、重试和历史

- 构建、测试、双架构检查失败或取消：不更新 latest，不公开 Release。Actions 记录结果；草稿和预留 Git 标签不能当作成功版本。
- 版本标签预留后不移动、不复用。失败/取消可能留下序号空缺；重新运行会分配下一个未使用的版本号，不覆盖部分已上传的旧产物。
- main 在排队或构建期间发生变化时，旧运行拒绝更新 latest；新 main 的运行接续处理。Actions 可能合并替换排队任务，期间的源码提交仍在后续成功 Release 的比较范围里。
- GitHub 与 GHCR 不能进行跨服务原子事务：如果镜像已经提升 latest，但最后写 Release 失败，Actions 会报错并保留镜像 digest/状态附件；这表示发布记录未完成，不表示镜像构建失败。检查摘要和实际 latest，再根据附件修复原 Release 草稿；不要移动标签或冒充 NAS 已升级。
- 成功 Release 长期保留；每次运行另提供 `release-record-*` 附件（90 天，受仓库保留策略影响），包含 `release-record.json` 和 `release-notes.md`。记录步骤执行前被强制终止时，以 Actions 原始状态为准。
- 首次自动记录没有成功发布基线，不伪造历史增量；提供当前提交和固定到本版本的完整自用更新日志。后续比较跳过失败草稿，从上次成功发布累计计算。
- 已有 `sha-*` 镜像不删除；新流程只发布统一自用版本标签与 latest。镜像 OCI `org.opencontainers.image.version` 是自用版本，`org.opencontainers.image.revision` 是源码 SHA。程序内上游 `VERSION` 与 `package.json` 元数据暂不改写为构建号，避免污染上游同步。

`Forward` 插件构建目前仍有 Node 内建模块/依赖解析兼容失败；不作为 NAS 发布成功证据，也不在本次维护中擅自大幅改造播放器打包链路。HF 自动同步工作流已删除，不再维护该发布方式。
