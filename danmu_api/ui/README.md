# 目录

- [UI 系统使用说明](#ui-系统使用说明)
- [功能概览](#功能概览)
- [访问方式](#访问方式)
- [功能详解](#功能详解)
  - [1. 配置预览](#1-配置预览)
  - [2. 日志查看](#2-日志查看)
  - [3. 接口调试](#3-接口调试)
  - [4. 推送弹幕](#4-推送弹幕)
  - [5. 系统配置](#5-系统配置)
- [安全说明](#安全说明)
- [部署平台支持](#部署平台支持)
- [部署平台环境变量配置指南](#部署平台环境变量配置指南)
  - [各平台变量获取详细步骤](#各平台变量获取详细步骤)
    - [1. Vercel 平台](#1-vercel-平台)
    - [2. Netlify 平台](#2-netlify-平台)
    - [3. EdgeOne (腾讯云 Pages) 平台](#3-edgeone-腾讯云-pages-平台)
    - [4. Cloudflare 平台](#4-cloudflare-平台)
  - [常见问题](#常见问题)
- [API 端点](#api-端点)
- [故障排除](#故障排除)

# UI 系统使用说明

本项目包含一个基于 Web 的用户界面，用于管理和配置弹幕 API 服务。以下是 UI 系统的详细使用说明。

## 功能概览

UI 系统提供了以下主要功能模块：

1. **配置预览** - 查看当前生效的环境变量配置
2. **日志查看** - 实时查看系统运行日志
3. **接口调试** - 测试和调试 API 接口
4. **推送弹幕** - 向播放器推送弹幕
5. **系统配置** - 环境变量配置和系统管理

## 访问方式

UI 系统需要通过在 URL 中添加 TOKEN 来访问，以确保安全性：

- 普通功能访问：`http://your-domain/{TOKEN}`
- 系统管理功能：`http://your-domain/{ADMIN_TOKEN}`

## 功能详解

### 1. 配置预览

在配置预览页面，您可以：

- 查看当前生效的环境变量配置
- 了解各配置项的当前值和描述
- 配置按类别分组显示（API配置、源配置、匹配配置等）

### 2. 日志查看

日志查看页面提供：

- 实时日志监控
- 刷新日志功能
- 清空日志功能（需要 ADMIN_TOKEN）

### 3. 接口调试

接口调试功能允许您：

- 选择不同的 API 接口进行测试
- 输入接口参数
- 发送请求并查看响应结果
- 支持的接口包括：
  - 搜索动漫 - `/api/v2/search/anime`
  - 搜索剧集 - `/api/v2/search/episodes`
  - 匹配动漫 - `/api/v2/match`
  - 获取番剧详情 - `/api/v2/bangumi/:animeId`
  - 获取弹幕 - `/api/v2/comment/:commentId`

### 4. 推送弹幕

推送弹幕功能支持：

- 向 OK 影视等播放器推送弹幕
- 搜索动漫并选择剧集
- 推送地址格式如：`http://127.0.0.1:9978/action?do=refresh&type=danmaku&path=`
- 需要在同一局域网或使用公网 IP

### 5. 系统配置

系统配置页面包含：

#### 环境变量管理
- **API配置** - API 相关设置
- **源配置** - 数据源配置
- **匹配配置** - 匹配算法设置
- **弹幕配置** - 弹幕相关参数
- **缓存配置** - 缓存策略设置
- **系统配置** - 系统级配置

#### 配置项类型
- **文本** - 普通文本输入
- **布尔值** - 开关选择
- **数字** - 数字滚轮输入 (带范围限制)
- **单选** - 从预定义选项中选择
- **多选** - 选择多个选项并可拖动排序

#### 系统管理功能
- **清理缓存** - 清除系统缓存（需要 ADMIN_TOKEN）
- **重新部署** - 重新部署系统（需要 ADMIN_TOKEN）

## 安全说明

- 访问 UI 系统需要在 URL 中配置 TOKEN
- 系统管理功能（日志查看、环境变量配置等）需要 ADMIN_TOKEN
- 确保 TOKEN 和 ADMIN_TOKEN 的安全性

## 部署平台支持

系统支持多种部署平台：

- Node.js
- Vercel
- Netlify
- Cloudflare
- Docker
- EdgeOne

根据部署平台的不同，可能需要配置额外的环境变量。

## 部署平台环境变量配置指南

### 平台与所需变量对照表

| 平台 | DEPLOY_PLATFROM_ACCOUNT | DEPLOY_PLATFROM_PROJECT | DEPLOY_PLATFROM_TOKEN |
|------|----------------------|----------------------|---------------------|
| Vercel | ❌ | ✅ | ✅ |
| Netlify | ✅ | ✅ | ✅ |
| EdgeOne | ❌ | ✅ | ✅ |
| Cloudflare | ✅ | ✅ | ✅ |
| Node.js | ❌ | ❌ | ❌ |
| Docker | ❌ | ❌ | ❌ |

---

### 各平台变量获取详细步骤

#### 1. Vercel 平台

#### 需要的变量
- `DEPLOY_PLATFROM_PROJECT`: 项目 ID
- `DEPLOY_PLATFROM_TOKEN`: API Token

#### 获取步骤

**获取 Project ID (`DEPLOY_PLATFROM_PROJECT`)**

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择你的项目
3. 进入项目后,点击 **Settings** 标签
4. 在左侧菜单中选择 **General**
5. 向下滚动找到 **Project ID** 部分
6. 复制显示的项目 ID(格式类似: `prj_xxxxxxxxxxxx`)

**获取 API Token (`DEPLOY_PLATFROM_TOKEN`)**

1. 点击右上角头像,选择 **Settings**
2. 在左侧菜单中选择 **Tokens**
3. 点击 **Create Token** 按钮
4. 输入 Token 名称(如: `environment-variables-api`)
5. 选择 **Scope**:
   - 可以选择 **Full Account** 或特定项目
   - 建议选择特定项目以提高安全性
6. 设置过期时间(可选)
7. 点击 **Create** 创建 Token
8. **立即复制并保存** Token(只显示一次)

---

### 2. Netlify 平台

#### 需要的变量
- `DEPLOY_PLATFROM_ACCOUNT`: 账户 ID
- `DEPLOY_PLATFROM_PROJECT`: 站点 ID
- `DEPLOY_PLATFROM_TOKEN`: Personal Access Token

#### 获取步骤

**获取 Account ID (`DEPLOY_PLATFROM_ACCOUNT`)**

1. 登录 [Netlify Dashboard](https://app.netlify.com/)
2. 点击左下角头像,选择 **User settings**
3. 点击 **Team settings** 可以看到你的 Account Slug
4. 或者在左侧菜单选择 **Applications**
5. 在 API 端点中可以找到 Account ID

**获取 Site ID (`DEPLOY_PLATFROM_PROJECT`)**

1. 在 Netlify Dashboard 中选择你的项目
2. 进入项目后,点击 **Project configuration**
3. 在 **General** > **Project details** 部分
4. 找到 **Project information** 下的 **Project ID**
5. 复制显示的站点 ID(格式类似: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

**获取 Personal Access Token (`DEPLOY_PLATFROM_TOKEN`)**

1. 点击左下角头像,选择 **User settings**
2. 在左侧菜单中选择 **Applications**
3. 滚动到 **Personal access tokens** 部分
4. 点击 **New access token** 按钮
5. 输入 Token 描述(如: `Environment Variables API`)
6. 点击 **Generate token**
7. **立即复制并保存** Token(只显示一次)

---

### 3. EdgeOne (腾讯云 Pages) 平台

#### 需要的变量
- `DEPLOY_PLATFROM_PROJECT`: 项目 ID
- `DEPLOY_PLATFROM_TOKEN`: API 密钥

#### 获取步骤

**获取 Project ID (`DEPLOY_PLATFROM_PROJECT`)**

1. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone)
2. 进入 **Pages** 服务
3. 选择你的项目
4. 在URL可以看到项目 ID(格式类似: `pages-xxxxxxxxxxxx`)

**获取 API 密钥 (`DEPLOY_PLATFROM_TOKEN`)**

1. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone)
2. 进入 **Pages** 服务
3. 选择 **API Token** 标签页 
4. 点击 **创建 API Token** 按钮
5. 输入描述和过期时间，点击提交后复制相应Token

---

### 4. Cloudflare 平台

#### 需要的变量
- `DEPLOY_PLATFROM_ACCOUNT`: 账户 ID
- `DEPLOY_PLATFROM_PROJECT`: Workers 脚本名称
- `DEPLOY_PLATFROM_TOKEN`: API Token

#### 获取步骤

**获取 Account ID (`DEPLOY_PLATFROM_ACCOUNT`)**

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 在右侧可以看到 **Account ID**
3. 或者点击任意域名,在右侧栏可以找到 **Account ID**
4. 复制该 ID(格式类似: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

**获取 Workers 脚本名称 (`DEPLOY_PLATFROM_PROJECT`)**

1. 在 Cloudflare Dashboard 左侧菜单选择 **Workers & Pages**
2. 找到你的 Workers 脚本
3. 脚本名称就是列表中显示的名称
4. 或者点击进入脚本详情,在 URL 中可以看到脚本名称

**获取 API Token (`DEPLOY_PLATFROM_TOKEN`)**

1. 点击右上角头像,选择 **配置文件**
2. 在左侧菜单选择 **API Tokens**
3. 点击 **Create Token** 按钮
4. 可以选择模板或自定义:
   - 选择 **Edit Cloudflare Workers** 模板
   - 或创建 **Custom token**
5. 配置权限:
   - **Account** > **Workers Scripts** > **Edit**
   - 选择特定账户
6. (可选)设置 IP 限制和 TTL
7. 点击 **Continue to summary**
8. 确认后点击 **Create Token**
9. **立即复制并保存** Token(只显示一次)

---

### 常见问题

**Q: Token 创建后忘记复制怎么办?**  
A: 大多数平台的 Token 只显示一次,如果忘记复制需要删除后重新创建。

## API 端点

在 UI 页面顶部显示当前 API 端点，可点击复制到剪贴板。

## 故障排除

- 如果无法访问功能页面，请检查 URL 中的 TOKEN 是否正确
- 如果系统管理功能不可用，请确认 ADMIN_TOKEN 等环境变量是否已配置
- 如遇到其他问题，请查看系统日志获取更多信息
