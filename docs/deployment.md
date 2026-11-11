# NAS 部署、迁移与回滚

仅维护 NAS Docker Compose 部署。首次部署见 [README](../README.md#nas-首次部署)，模板为 [compose.nas.yml](../compose.nas.yml)。本文不记录任何真实 NAS 地址、私人目录或部署凭据。

## 本次精简源码的本地构建

精简版镜像随 main 推送发布；确认对应发布流程成功并且 Release 记录已更新 latest 后，再按下文升级。也可在项目根目录自行构建：

```bash
docker build -t danmu-api-nas-slim:local .
```

测试 Compose 使用 `image: danmu-api-nas-slim:local`，并保留模板中的端口和配置、缓存目录挂载。配置文件从 `config/.env.example` 复制，填入自己的 TOKEN。本地镜像仍需按下文完成 NAS 启动和真实请求验收。

## 选择镜像

- 部署镜像：`ghcr.io/xlmc/danmu_api:latest`，由 GitHub Actions 构建，不需要 Docker Hub 账户，不要求固定版本。
- 源码标签、镜像标签和 Release 统一使用 `xdanmu-v0.N`（历史版本可能使用 `custom-YYYY.MM.DD.N`）；版本标签与 digest 用于追溯和回滚，不作为日常部署必填项。已有历史 SHA 镜像不会删除。
- `latest` 随 main 发布变化。迁移/回滚不要仅记录 latest，应记录实际镜像 ID/digest。
- 从 [Releases](https://github.com/xlmc/danmu_api/releases) 或对应提交成功的 [发布工作流](https://github.com/xlmc/danmu_api/actions/workflows/docker-image.yml) 查看同名版本更新说明，核对 NAS 架构是否为支持的 `linux/amd64` 或 `linux/arm64`。
- 首先在 NAS 执行 `docker pull ghcr.io/xlmc/danmu_api:latest`。若失败，检查标签是否存在、网络与包可见性；需要认证时使用具备包读取权限的凭据登录 GHCR，勿将凭据写入仓库。

**本机/CI 构建成功、注册表中存在镜像、NAS 能拉取、应用实际可用，必须分别验证。** 工作流发布不等于 NAS 已升级。

## 1. 保存现状与备份

1. 在原项目记录服务名、项目名、Compose 文件和所有环境文件，记录旧容器的镜像 ID、digest、端口、实际挂载目录及网络设置。保留旧镜像，必要时导出为离线备份。
2. 停止写入后备份挂载到 `/app/config`、`/app/.cache` 的整个目录，以及其他自定义持久化目录。旧缓存目录可能含有已停用功能的数据，升级前仍需完整备份。精简版不再读取收藏和本地弹幕文件，不自动删除旧文件。
3. 存在 Redis 或其他外置持久化时另行备份，确认恢复方法。备份放在项目之外并限制读取权限。
4. 测试期间如恢复旧服务供日常使用，正式切换前再次停止写入并做最终备份，避免丢失测试期间新增的数据。

升级后播放器与管理页面统一使用原 `TOKEN`；旧 `ADMIN_TOKEN` 不再提供访问权限。

**不要用配置示例覆盖原 `config/.env`。保留 TOKEN 及来源配置，不把关闭鉴权作为迁移步骤。** 不要把备份、令牌、实际部署路径上传到公开 Git/Release。

## 2. 独立测试

把数据复制到单独测试目录，不直接挂载生产目录。下面的 Compose 放在该测试目录中；示例端口可换为任意未占用端口：

```yaml
services:
  danmu-api-test:
    image: ghcr.io/xlmc/danmu_api:latest
    ports:
      - "19321:9321"
    volumes:
      - ./data/config:/app/config
      - ./data/.cache:/app/.cache
    restart: "no"
```

测试同样使用 latest。外置 Redis、计划任务及第三方写入目标也必须隔离：不要让测试副本读写生产存储或重复执行生产任务。保留业务配置，但按需禁用测试中的调度；未完成隔离前不要启动。

```bash
docker compose -p danmu-migration-test -f compose.test.yml config --quiet
docker compose -p danmu-migration-test -f compose.test.yml pull
docker compose -p danmu-migration-test -f compose.test.yml up -d
docker compose -p danmu-migration-test -f compose.test.yml logs --tail=100
```

测试清单：管理登录及鉴权、已知剧名和季集匹配、弹幕获取、分片、过滤、缓存命中与重启恢复，以及实际播放器调用。检查容器架构、目录权限、是否意外生成空配置。验收后停止测试项目。

## 3. 切换原生产项目

**仅修改原 Compose 的 `image`，不要用首次部署模板替换原文件。** 原来的相对路径不要随文件移动；绝对路径、端口、环境变量、网络、容器名和项目名都保持不变，尤其避免误挂到一个空数据目录。

将镜像改为 latest：

```yaml
image: ghcr.io/xlmc/danmu_api:latest
```

在原目录操作；将 `compose.yml` 和 `<SERVICE>` 替换为实际文件名与服务名。如果原部署指定了 `-p` 或 `--env-file`，每条命令继续使用相同参数：

```bash
# 提前校验和下载；这些步骤成功后再停止旧服务
docker compose -f compose.yml config --quiet
docker compose -f compose.yml pull <SERVICE>
# 核对拉取结果与测试镜像是否相同；若 latest 已变化，先重新测试
docker compose -f compose.yml stop <SERVICE>
# 此时完成最终一致性备份，再重建该服务
docker compose -f compose.yml up -d --no-deps --force-recreate <SERVICE>
docker compose -f compose.yml logs --tail=100 <SERVICE>
```

不要用 `down -v` 清除卷，不要另建一个共享生产数据的项目。使用 NAS 图形化管理时，按同一原则在原项目编辑镜像并重新创建服务。

确认鉴权、原数据、播放器和关键功能后，在**私有运维记录**中保存实际部署镜像、时间和验收结果；公开版本说明只记录通用功能、兼容性和构建信息。

## 4. 日常升级 latest

备份并保留旧镜像后，在原目录执行 `docker compose -f compose.yml pull <SERVICE>`；成功后执行 `docker compose -f compose.yml up -d --no-deps <SERVICE>`，再检查日志和功能。继续使用原项目名和环境文件参数。

不用修改 image 标签，也不用创建自用版本标签才能升级。latest 只表示浮动镜像标签，不会主动更新已运行容器；单独执行 restart 也不会更新镜像。本仓库不因此增加自动部署服务。

## 5. 回滚

1. 停止新容器，避免继续写入数据。
2. 恢复原 Compose/环境配置，并将 image 固定为事先保留的旧镜像。不能指望旧 latest 仍指向原内容。
3. 新版本若写入数据，必要时恢复升级前配置、缓存和外置存储快照；不能只换镜像而忽略数据兼容性。
4. 在原项目重建旧服务，检查日志和原有功能。恢复备份会丢弃备份之后的新增数据，应先保留故障现场副本。

完成生产验收并确认回滚路径之前，不清理旧镜像和备份。本仓库不会自动连接、升级或更改 NAS。
