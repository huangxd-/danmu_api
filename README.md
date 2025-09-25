# LogVar 弹幕 API 服务器

[![GitHub](https://img.shields.io/badge/-GitHub-181717?logo=github)](https://github.com/huangxd-/damnu_api)
![GitHub License](https://img.shields.io/github/license/huangxd-/danmu_api)
![Docker Pulls](https://img.shields.io/docker/pulls/logvar/danmu-api)
[![telegram](https://img.shields.io/static/v1?label=telegram&message=telegram_channel&color=blue)](https://t.me/logvar_danmu_channel)
[![telegram](https://img.shields.io/static/v1?label=telegram&message=telegram_group&color=blue)](https://t.me/logvar_danmu_group)

一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口，并提供日志记录，支持vercel/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。

本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。

有问题提issue或 [私信机器人](https://t.me/ddjdd_bot) 都ok。

新加了 [tg频道](https://t.me/logvar_danmu_channel) ，方便发送更新通知，以及群组，太多人私信咨询了，索性增加一个 [互助群](https://t.me/logvar_danmu_group) ，大家有问题可以在群里求助。

> 请不要在国内媒体平台宣传本项目！

## 功能
- **API 接口**：
  - `GET /api/v2/search/anime?keyword=${queryTitle}`：根据关键字搜索动漫。
  - `POST /api/v2/match`：根据关键字匹配动漫，用于自动匹配。
  - `GET /api/v2/search/episodes`：根据关键词搜索所有匹配的剧集信息。
  - `GET /api/v2/bangumi/:animeId`：获取指定动漫的详细信息。
  - `GET /api/v2/comment/:commentId?withRelated=true&chConvert=1`：获取指定弹幕评论，支持返回相关评论和字符转换。
  - `GET /api/logs`：获取最近的日志（最多 500 行，格式为 `[时间戳] 级别: 消息`）。
- **日志记录**：捕获 `console.log`（info 级别）和 `console.error`（error 级别），JSON 内容格式化输出。
- **部署支持**：支持本地运行、Docker 容器化、Vercel 一键部署、Cloudflare 一键部署和 Docker 一键启动。

## 前置条件
- Node.js（v18.0.0 或更高版本；理论兼容更低版本，请自行测试）
- npm
- Docker（可选，用于容器化部署）

## 本地运行
1. **克隆仓库**：
   ```bash
   git clone <仓库地址>
   cd <项目目录>
   ```

2. **安装依赖**：
   ```bash
   npm install
   ```

3. **启动服务器**：
   ```bash
   npm start
   ```
   服务器将在 `http://{ip}:9321` 运行，默认token是`87654321`。
   或者使用下面的命令
   ```bash
   # 启动
   node ./danmu_api/server.js
   # 测试
   node --test ./danmu_api/worker.test.js
   ```

4. **测试 API**：
   使用 Postman 或 curl 测试：
   - `GET http://{ip}:9321/87654321`
   - `GET http://{ip}:9321/87654321/api/v2/search/anime?keyword=生万物`
   - `POST http://{ip}:9321/87654321/api/v2/api/v2/match`
   - `GET http://{ip}:9321/87654321/api/v2/search/episodes?anime=生万物`
   - `GET http://{ip}:9321/87654321/api/v2/bangumi/1`
   - `GET http://{ip}:9321/87654321/api/v2/comment/1?withRelated=true&chConvert=1`
   - `GET http://{ip}:9321/87654321/api/logs`

## 使用 Docker 运行
1. **构建 Docker 镜像**：
   ```bash
   docker build -t danmu-api .
   ```

2. **运行容器**：
   ```bash
   docker run -d -p 9321:9321 --name danmu-api -e TOKEN=your_token_here danmu-api
   ```
   - 使用`-e TOKEN=your_token_here`设置`TOKEN`环境变量，覆盖Dockerfile中的默认值。

3. **测试 API**：
   使用 `http://{ip}:9321/{TOKEN}` 访问上述 API 接口。

## Docker 一键启动 【推荐】
1. **拉取镜像**：
   ```bash
   docker pull logvar/danmu-api:latest
   ```

2. **运行容器**：
   ```bash
   docker run -d -p 9321:9321 --name danmu-api -e TOKEN=your_token_here logvar/danmu-api:latest
   ```
   - 使用`-e TOKEN=your_token_here`设置`TOKEN`环境变量。

   ```yaml
   services:
     danmu-api:
       image: logvar/danmu-api:latest
       container_name: danmu-api
       ports:
         - "9321:9321"
       environment:
         - TOKEN=your_token_here  # 请将your_token_here 替换为实际的 Token 值
       restart: unless-stopped    # 可选配置，容器退出时自动重启（非必需，可根据需求删除）
   ```
   - 或使用docker compose部署。

3. **测试 API**：
   使用 `http://{ip}:9321/{TOKEN}` 访问上述 API 接口。

## 部署到 Vercel 【推荐】

### 一键部署
点击以下按钮即可将项目快速部署到 Vercel：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/huangxd-/danmu_api&project-name=danmu_api&repository-name=danmu_api)

**注意**：请将按钮链接中的 `https://github.com/huangxd-/danmu_api` 替换为你的实际 Git 仓库地址。编辑 `README.md` 并更新链接后，推送到仓库，点击按钮即可自动克隆和部署。
- **设置环境变量**：部署后，在 Vercel 仪表板中：
  1. 转到你的项目设置。
  2. 在“Environment Variables”部分添加 `TOKEN` 变量，输入你的 API 令牌值。
  3. 保存更改并重新部署。
- 示例请求：`https://{your_domian}.vercel.app/87654321/api/v2/search/anime?keyword=子夜归`

### 优化点
Settings > Functions > Advanced Setting > Function Region 切换为 Hong Kong，能提高访问速度，体验更优
> hk有可能访问不了360，也可以尝试切其他region，如新加坡等

## 部署到 腾讯云 edgeone pages

### 一键部署
[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/pages/new?template=https://github.com/huangxd-/danmu_api&project-name=danmu-api&root-directory=.%2F&env=TOKEN)

> 注意：部署时请在环境变量配置区域填写你的TOKEN值，该变量将用于API服务的身份验证相关功能
> 
> 示例请求：`https://{your_domian}/{TOKEN}/api/v2/search/anime?keyword=子夜归`确认是否部署成功
>
> 部署的时候项目加速区域最好设置为"全球可用区（不含中国大陆）"，不然不绑定自定义域名貌似只能生成3小时的预览链接？[相关文档](https://edgeone.cloud.tencent.com/pages/document/175191784523485184)
> 
> 也可直接用国际站的部署按钮一键部署，默认选择"全球可用区（不含中国大陆）" [![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?template=https://github.com/huangxd-/danmu_api&project-name=danmu-api&root-directory=.%2F&env=TOKEN)
> 
<img src="https://i.mji.rip/2025/09/17/3a675876dabb92e4ce45c10d543ce66b.png" style="width:400px" />

> 如果访问遇到404等问题，可能是edgeone pages修改了访问策略，每次接口请求都转发到了新的环境，没有缓存，导致获取不到对应的弹幕，推荐用vercel部署。

## 部署到 Cloudflare

### 一键部署
点击以下按钮即可将项目快速部署到 Cloudflare：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huangxd-/danmu_api)

**注意**：请将按钮链接中的 `https://github.com/huangxd-/danmu_api` 替换为你的实际 Git 仓库地址。编辑 `README.md` 并更新链接后，推送到仓库，点击按钮即可自动克隆和部署。
- **设置环境变量**：部署后，在 Cloudflare 仪表板中：
  1. 转到你的 Workers 项目。
  2. 转到“Settings” > “Variables”。
  3. 添加 `TOKEN` 环境变量，输入你的 API 令牌值。
  4. 保存并部署。
- 示例请求：`https://{your_domian}.workers.dev/87654321/api/v2/search/anime?keyword=子夜归`

### 手动部署
创建一个worker，将`danmu_api/worker.js`里的代码直接拷贝到你创建的`worker.js`里，然后点击部署。

> cf部署可能不稳定，推荐用vercel部署。

## API食用指南
支持 forward/senplayer/hills/小幻/yamby/eplayerx/afusekt 等支持弹幕API的播放器。

以`senplayer`为例：
1. 获取到部署之后的API地址，如 `http://192.168.1.7:9321/87654321` ，其中`87654321`是默认token，如果有自定义环境变量TOKEN，请替换成相应的token
2. 将API地址填入自定义弹幕API，在`设置 - 弹幕设置 - 自定义弹幕API`
3. 播放界面点击`弹幕按钮 - 搜索弹幕`，选择你的弹幕API，会根据标题进行搜索，等待一段时间，选择剧集就行。
<img src="https://i.mji.rip/2025/09/14/1dae193008f23e507d3cc3733a92f0a1.jpeg" style="width:400px" />
<img src="https://i.mji.rip/2025/09/14/506fd7810928088d7450be00f67f27e6.png" style="width:400px" />
<img src="https://i.mji.rip/2025/09/14/e206ab329c232d8bed225c6a9ff6f506.jpeg" style="width:400px" />
<img src="https://i.mji.rip/2025/09/14/80aa5205d49a767447f61938f2dada20.jpeg" style="width:400px" />
<img src="https://i.mji.rip/2025/09/14/9fdf945fb247994518042691f60d7849.jpeg" style="width:400px" />
<img src="https://i.mji.rip/2025/09/14/dbacc0cf9c8a839f16b8960de1f38f11.jpeg" style="width:400px" />

> 注意：小幻在填写API的时候需要在API后面加上`/api/v2`，如`http://192.168.1.7:9321/87654321/api/v2`
> 
> 有很多人问FW能不能用，FW推荐直接使用插件，如果非要使用，则可以配合 `https://raw.githubusercontent.com/huangxd-/ForwardWidgets/refs/heads/main/widgets.fwd` 里的`danmu_api`插件使用

## 环境变量列表
| 变量名称      | 描述 |
| ----------- | ----------- |
| TOKEN      | 【可选】自定义用户token，不填默认为`87654321`       |
| OTHER_SERVER   | 【可选】兜底第三方弹幕服务器，不填默认为`https://api.danmu.icu`       |
| VOD_SERVER      | 【可选】vod查询站点，不填默认为`https://www.caiji.cyou`       |
| BILIBILI_COOKIE      | 【可选】b站cookie（填入后能抓取完整弹幕），如 `buvid3=E2BCA ... eao6; theme-avatar-tip-show=SHOWED`，请自行通过浏览器或抓包工具抓取    |
| YOUKU_CONCURRENCY    | 【可选】youku弹幕请求并发数，用于加快youku弹幕请求速度，不填默认为`8`，最高`16`       |
| SOURCE_ORDER    | 【可选】源排序，用于按源对返回资源的排序（注意：先后顺序会影响自动匹配最终的返回），默认是`vod,360,renren`，表示vod数据排在最前，renren数据排在最后，示例`360,renren`：只返回360数据和renren数据，且360数据靠前       |

## 项目结构
```
danmu_api/
├── .github/
│   └── workflows/
│       └── docker-image.yml
├── danmu_api/
│   ├── esm-shim.js     # Node.js低版本兼容层
│   ├── server.js       # 本地node启动脚本
│   ├── worker.js       # 主 API 服务器代码
│   ├── worker.test.js  # 测试文件
├── node-functions/
│   ├── [[...path]]..js # edgeone pages 所有路由跳转指向index
│   ├── index.js        # edgeone pages 中间处理逻辑
├── .gitignore
├── Dockerfile
├── package.json
├── vercel.json
├── README.md
```

## 注意事项
- 日志存储在内存中，服务器重启后会清空。
- `/api/logs` 中的 JSON 日志会格式化显示，带缩进以提高可读性。
- 确保 `package.json` 中包含 `node-fetch` 依赖。
- 一键部署需要将项目推送到公开的 Git 仓库（如 GitHub），并更新按钮中的仓库地址。
- 运行 Docker 容器时，需通过 `-e TOKEN=your_token_here` 传递 `TOKEN` 环境变量。
- cloudflare貌似被哔风控了。
- 如果想更换兜底第三方弹幕服务器，请添加环境变量`OTHER_SERVER`，示例`https://api.danmu.icu`。
- 如果想更换vod站点，请添加环境变量`VOD_SERVER`，示例`https://www.caiji.cyou`。
- 推荐vercel和claw部署，cloudflare好像不稳定，当然最稳定还是自己本地docker部署最佳。

### 关联项目
[danmu_api 自动同步部署方案 - 永远保持最新版本！实时同步原作者更新](https://github.com/xiaoyao20084321/log-var-danmu-deployment-guide)

### 贡献者
<a href="https://github.com/huangxd-/danmu_api/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huangxd-/danmu_api" alt="contributors" />
</a>

### 📈项目 Star 数增长趋势
#### Star History
[![Star History Chart](https://api.star-history.com/svg?repos=huangxd-/danmu_api&type=Date)](https://www.star-history.com/#huangxd-/danmu_api&Date)
