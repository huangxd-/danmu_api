# 部署平台环境变量配置指南

## 平台与所需变量对照表

| 平台 | DEPLOY_PLATFROM_ACCOUNT | DEPLOY_PLATFROM_PROJECT | DEPLOY_PLATFROM_TOKEN |
|------|----------------------|----------------------|---------------------|
| Vercel | ❌ | ✅ | ✅ |
| Netlify | ✅ | ✅ | ✅ |
| EdgeOne | ❌ | ✅ | ✅ |
| Cloudflare | ✅ | ✅ | ✅ |

---

## 各平台变量获取详细步骤

### 1. Vercel 平台

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

## 常见问题

**Q: Token 创建后忘记复制怎么办?**  
A: 大多数平台的 Token 只显示一次,如果忘记复制需要删除后重新创建。

**Q: 如何测试 Token 是否有效?**  
A: 可以使用 curl 或 Postman 发送测试请求到对应平台的 API 端点。

**Q: 多个项目可以共用一个 Token 吗?**  
A: 可以,但建议为不同项目创建不同的 Token,便于管理和权限控制。