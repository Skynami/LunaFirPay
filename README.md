<div align="center">

# 💳 LunaFirPay Server

**基于 Node.js 的高性能支付平台后端**</br>
**你就是下一个麻瓜宝/番茄支付**



*复刻自彩虹易支付 · 以最低配置运行最高性能*

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8+-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![License](https://img.shields.io/badge/License-WTFPL-brightgreen?style=flat-square)](http://www.wtfpl.net/)
[![Telegram](https://img.shields.io/badge/Telegram-Group-blue?style=flat-square&logo=telegram)](https://t.me/gaoyaerver)

</div>

---

## ✨ 特性

| 特性 | 描述 |
|------|------|
| 🤖 **Telegram Bot** | 收款通知、余额查询、绑定管理，无需二次开发 |
| 🔒 **代理回调** | 支持通过代理服务器转发回调，防止暴露源站 IP |
| ⚡ **高性能** | 单进程支撑高并发，资源占用低 |
| 🔌 **插件化** | 56+ 支付通道插件，热加载支持 |

## 📋 环境要求

- **Node.js** 18+
- **MySQL** 8+
- **内存** 1G+

> ## ⚠️ 警告：如果要运行在生产环境，必须开启WAF，不论是长亭、宝塔还是开心版宝塔，必须开启！

## 🚀 快速开始

### 使用 Docker Compose 一键部署

本项目已内置 Docker 部署文件，支持一条命令启动应用和数据库。

> ⚠️ **重要说明（必读）**
>
> - 使用 Docker 部署**不代表可以平滑升级**。
> - 实际更新时，通常需要你自己处理镜像更新、数据库迁移、配置兼容与回滚。
> - 换句话说，任何更新基本都和你没什么关系，还是要靠你自己运维。
> - 如果只是玩玩、测试体验，可以使用 Docker。
> - 如果准备生产长期运行，建议手搓部署并自行维护升级链路。

```bash
docker compose up -d --build
```

默认会启动：

- `lunafirpay-app`（端口 `3000`）
- `lunafirpay-db`（端口 `3306`）

#### 配置方式（单一配置源）

Docker 部署只使用根目录 `config.yaml`，不需要维护第二份 Docker 专用配置。

你只需要修改 `config.yaml` 里的数据库配置：

```yaml
database:
  host: "db"
  port: 3306
  user: "你的数据库用户"
  password: "你的数据库密码"
  database: "lunafirpay"
```

> `host` 在 compose 场景必须是 `db`（MySQL 服务名）。

#### 自动数据库用户同步

应用容器启动时会先执行数据库用户同步脚本：

- 按 `config.yaml` 读取 `database.user/password/database`
- 使用 MySQL root 权限自动创建/更新对应用户
- 自动授予该库权限后再启动 Node.js 服务

因此你只改 `config.yaml` 一处即可，避免账号不一致导致 `Access denied`。

#### 首次部署/重置数据库

首次启动时会自动执行 `initialization.sql` 初始化数据库。

如果你改了数据库账号、密码或库结构，建议重建数据卷让初始化重新执行：

```bash
docker compose down -v
docker compose up -d --build
```

> `down -v` 会删除数据库数据，请先备份。

#### 如何更新（Docker）

适用场景：你使用 `docker compose` 部署了 `lunafirpay-app` + `lunafirpay-db`。

1. 进入目录并赋予执行权限（首次执行时）

```bash
cd server
chmod +x .update-docker.sh
```

2. 执行更新

```bash
./.update-docker.sh
```

3. 如果你的数据库 root 密码不是默认值，使用下面命令

```bash
DB_ROOT_PASSWORD=你的root密码 DB_NAME=lunafirpay ./.update-docker.sh
```

4. 更新完成后检查容器状态

```bash
docker compose ps
docker logs --tail 100 lunafirpay-app
```

说明：

- 脚本会自动判断镜像时间戳版本（新版本更大才升级）。
- 脚本会自动对比 `initialization.sql` 的哈希，只有变更时才执行数据库迁移。
- 脚本不会执行 `down -v`，不会主动删除数据库卷数据。

#### 如何更新（非 Docker，推荐生产）

适用场景：你是手动部署（node app.js / systemd / pm2）。

1. 进入目录并赋予执行权限（首次执行时）

```bash
cd server
chmod +x update.sh
```

2. 执行更新

```bash
./update.sh
```

3. 常见可选参数

```bash
GIT_REF=origin/main SERVICE_NAME=lunafirpay ./update.sh
```

说明：

- 脚本会从 Git 拉取并切换到目标提交。
- 自动保留本地 `config.yaml`，避免更新覆盖运行配置。
- 自动处理本地未提交改动（stash）以避免更新冲突。
- 自动对比 `initialization.sql` 哈希并按需执行平滑数据库迁移。
- 最后自动重启服务（systemd / pm2 / nohup）。

### 使用官方自动构建的 Docker 镜像

本项目每次推送到 main 分支或发布新标签时，都会自动构建并推送 Docker 镜像到 GitHub Container Registry（GHCR）

你可以直接拉取官方镜像，无需本地构建：

```bash
docker pull ghcr.io/skynami/lunafirpay:latest
```

- 也可以拉取指定 tag，例如 `ghcr.io/skynami/lunafirpay:v1.0.0`
- 镜像自动构建流程见 `.github/workflows/docker-publish.yml`

### 手动部署

```bash
# 克隆仓库
git clone https://github.com/Skynami/LunaFirPay.git
cd LunaFirPay

# 安装依赖
npm install

# 导入数据库
mysql -u root -p your_database < initialization.sql

# 配置数据库
cp config.yaml.example config.yaml
# 编辑 config.yaml 填写数据库连接信息

# 修改根目录 nginx.conf 配置文件
nano nginx.conf

# 启动服务
node app.js
```

### 一键部署脚本

使用 `deploy.sh` 可以在 Linux 服务器上快速完成部署（自动安装 Node.js、配置数据库、systemd 守护进程）：

```bash
# 导入数据库信息
mysql -u root -p your_database < initialization.sql

# 运行一键部署脚本（root 运行）
bash deploy.sh

# 修改根目录 nginx.conf 配置文件
nano nginx.conf
```

> **💡 提示：** 搭建完成后，第一个注册的用户将自动成为管理员。

## 📁 项目结构

```
server/
├── app.js              # 应用入口
├── config.yaml         # 配置文件
├── dist/               # 前端构建产物
├── routes/             # 路由模块
│   ├── merchant/       # 商户端接口
│   └── provider/       # 服务商端接口
├── plugins/            # 支付通道插件
├── Telegram/           # Telegram Bot 模块
├── utils/              # 工具函数
```

### 路由说明

| 路径 | 说明 |
|------|------|
| `/direct/:token` | 直接收款页（渲染 `views/direct.ejs`） |
| `/api/pay/cashier` | 收银台页面 |
| `/api/pay/direct/create-order` | 直接收款创建订单 |
| `/api/pay/dopay` | 执行支付 |
| `/api/pay/qrcode` | 支付二维码 |
| `/api/pay/success` | 支付成功页 |
| `/submit.php` | 兼容易支付提交接口 |
| `/mapi.php` | 兼容易支付 MAPI |
| `/api.php` | 兼容易支付 API |

## 回调代理服务器

`callback-proxy.js` 是一个独立的 Node.js 回调中转服务，用于隐藏支付平台源站 IP。

### 工作原理

支付成功后，支付平台通过代理服务器向商户发送回调通知：

```
支付平台 -> 代理服务器 -> 商户服务器
```

请求格式：`https://代理域名/https://商户回调地址`

### 部署到云函数

支持部署到各云厂商的 Serverless 云函数：

| 云厂商 | 服务名称 |
|--------|----------|
| 阿里云 | 函数计算 FC |
| 腾讯云 | 云函数 SCF |
| AWS | Lambda |

> ⚠️ **注意：** 不支持 Cloudflare Workers，因为 Workers 不支持原生 Node.js `http` 模块，而且CPU时间严格限制，根本无法完成回调

**部署步骤：**

1. 创建云函数，运行环境选择 **Node.js 18+**
2. 上传 `callback-proxy.js` 代码
3. 根据云函数要求修改监听端口（如阿里云 FC 使用 `9000`）
4. **设置 HTTP 触发器/API 网关为「无需鉴权」**
5. 获取云函数的公网访问地址

> ⚠️ **注意：** 不需要太高性能，使用最低档的配置就可以完成，此举可以节省费用
**配置支付平台：**

在 `config.yaml` 中配置代理地址：

```yaml
callbackProxy: "https://your-proxy-domain.com/"
```

### 本地运行

```bash
node callback-proxy.js
# 默认监听 6666 端口
```

## 💬 社区

加入 Telegram 群组讨论交流：

[![Telegram Group](https://img.shields.io/badge/Telegram-Join%20Group-blue?style=for-the-badge&logo=telegram)](https://t.me/gaoyaerver)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📄 许可证

**无。** 爱干嘛干嘛，商用、修改、分发、二次销售随便你。


---

<div align="center">

**如果这个项目对你有帮助，请给一个 ⭐ Star**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Skynami/LunaFirPay&type=date&legend=top-left)](https://www.star-history.com/#Skynami/LunaFirPay&type=date&legend=top-left)