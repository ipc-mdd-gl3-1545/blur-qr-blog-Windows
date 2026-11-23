<div align="center">

<img src="assets/readme-cover.jpg" alt="模糊二维码 · 博客 Windows 单机版" width="100%">

<h1>模糊二维码 · 博客</h1>

<p><strong>Windows / macOS 单机版</strong> ヽ(✿ﾟ▽ﾟ)ノ</p>

<p>Node.js 22 ✦ 内置 SQLite ✦ 零第三方依赖 ✦ 一个进程跑完整个站</p>

<p><code>node server.js</code> ✧ <code>npm start</code> ✧ 不用装 Apache / MySQL / PHP</p>

</div>

---

## 这个仓库是什么呀 (｡･ω･｡)ﾉ♡

一个能自己写文章、传图、传视频、发弹幕的博客，**后端只有 `server.js` 一个文件**。
它同时干三件事：当 Web 服务器发静态页面、当 API 处理读写、把数据存进本机的 SQLite 文件。

装好 Node 就能跑，不用配数据库、不用建表、不用装扩展。整个项目目录拷到哪台机器都能直接活 (´｡• ᵕ •｡`)

## 和另一个仓库的关系 (๑•̀ㅂ•́)و✧

这套代码有两个版本，**前端页面完全一样，后端换了个芯**：

| 仓库 | 后端 | 数据 | 适合 |
| --- | --- | --- | --- |
| **本仓库** `blur-qr-blog-Windows` | Node.js 22 + `node:sqlite` | 本地 `data/blog.db` | 自己电脑上跑、做演示、小规模自用 |
| [blur-qr-blog-Ubuntu](https://github.com/ipc-mdd-gl3-1545/blur-qr-blog-Ubuntu) | Apache 2.4 + PHP 8.2 + MySQL 8 | MySQL 库 `blog` | 放服务器长期养，带 K8s、定时备份、SSH 控制台 |

> 两个仓库各自独立、都能单独 clone 运行，不是子模块。
> 想要"大厂那套"（网关、集群、观测中心、异地备份），去 Ubuntu 那个仓库；
> 只想在本机点开就写文章，留在这里就好 ٩(ˊᗜˋ*)و

---

## 30 秒跑起来 ✧*｡

需要 **Node.js ≥ 22.5**（因为用了内置的 `node:sqlite`）。

```bash
# 1. 进入项目
cd blur-qr-blog-Windows

# 2. 直接启动（零依赖，不需要 npm install）
npm start
#    或者： node server.js
```

启动后终端会打印：

```
✦ 模糊二维码 · 博客后端已启动
  本机访问      http://127.0.0.1:8080/
  管理后台      http://127.0.0.1:8080/manage
  │  已生成初始后台密码：xxxxxxxxxxxx  │
```

**第一次启动会自动生成一个随机后台密码**，就在终端里，记得抄下来。
想自己定密码，先建 `.env`：

```bash
cp .env.example .env
node tools/hash-password.js '你的密码'     # 把输出的 scrypt$... 粘到 .env 的 ADMIN_PASSWORD_HASH
```

改完重启服务生效。后台**不会**在首页留任何入口，只有知道 `ADMIN_PATH` 的人才打得开。

---

## 它都会做什么呀 ✧

| 小家伙 | 会做的事 |
| --- | --- |
| 🎬 首页 | 全屏视频背景 + 打字机标题 + 玻璃卡片 |
| 🧭 六个方向 | 前端 / 后端 / SRE / AI Agent / 数据库 / 计算机网络，各一页，带思维导图 |
| 📝 文章 | 只显示「封面 + 标题」，点进去是正文；支持小标题、列表、引用、粗体、行内代码、图片 |
| 🎞 小影院 | 上传本地视频、在线播放、游客发弹幕（服务器也存一份） |
| 🖼 上传 | 图片自动压缩，视频直传，进度条不卡页面 |
| 🛠 后台 | 写/改/删文章、管视频、删弹幕、翻日志、看数据库表、导出导入 JSON |
| 💾 备份 | 后台一键快照 `data/blog.db`，可下载、可删；命令行 `npm run backup` 也行 |
| 🔐 安全 | scrypt 密码哈希、签名 Cookie、同源校验、登录失败限速、后台路径可改 |

---

## 目录里都有啥

```
blur-qr-blog-Windows/
├─ server.js              ← 整个后端（HTTP + 路由 + 会话 + 日志），约 1700 行
├─ index.html             ← 首页
├─ article.html           ← 文章正文页
├─ admin.html             ← 后台（登录后可见）
├─ ai-agent / backend / database / frontend / network / sre.html   ← 六个方向页
├─ assets/                ← 样式、脚本、图片、首页视频
├─ tools/
│   ├─ hash-password.js   ← 生成后台密码哈希
│   ├─ backup.js          ← 命令行热备份（VACUUM INTO）
│   └─ clean-uploads.js   ← 清理没被引用的图片
├─ deploy/
│   ├─ install.sh         ← Ubuntu 服务器一键部署（Node + systemd + Nginx）
│   ├─ blog.service       ← systemd 单元
│   ├─ nginx.conf         ← 反代示例
│   └─ tunnel.sh          ← 内网穿透小工具
├─ data/                  ← 运行时生成：blog.db、日志、会话密钥、备份（不进 Git）
├─ uploads/               ← 上传的图片（不进 Git）
└─ .env.example           ← 配置样例
```

---

## 想放到服务器上？

虽然叫 Windows 版，但它就是纯 Node，Linux 一样跑。仓库里的 `deploy/install.sh` 会帮你：

```bash
# 把项目传到服务器后
sudo bash deploy/install.sh                    # 只装后端 + systemd
sudo bash deploy/install.sh blog.example.com   # 顺便配好 Nginx 反代
```

脚本会装 Node 22、建 `blog` 用户、同步代码到 `/opt/blog`、生成 `.env`、装 systemd 服务并开机自启。

> 要 **MySQL + 集群 + 观测中心 + 定时备份 + 浏览器 SSH** 那一整套，请用
> [blur-qr-blog-Ubuntu](https://github.com/ipc-mdd-gl3-1545/blur-qr-blog-Ubuntu)。

---

## 备份与恢复 (´｡• ᵕ •｡`)

两种方式，产物都是同一个东西——`data/blog.db` 的一份完整快照：

```bash
npm run backup                       # 备份到 data/backups/blog-YYYYMMDD-HHMMSS.db
node tools/backup.js /mnt/usb        # 备份到指定目录（网盘、U 盘都行）
```

后台 →「备份管理」→「立即备份」也一样，还能直接下载。默认保留最近 30 份。

**恢复**：停掉服务 → 把备份文件改名成 `data/blog.db` 覆盖回去 → 重新启动。
（`data/blog.db-wal`、`-shm` 一起删掉，让 SQLite 重新生成。）

---

## 配置速查

全部写在 `.env.example` 里，复制成 `.env` 再改。最常改的几个：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PORT` / `HOST` | 监听端口与地址 | `8080` / `0.0.0.0` |
| `ADMIN_PATH` | 后台路径，建议改成别人猜不到的 | `/manage` |
| `ADMIN_PASSWORD_HASH` | 密码哈希，用 `tools/hash-password.js` 生成 | 空（自动生成随机密码） |
| `DATA_DIR` / `UPLOAD_DIR` | 数据与上传目录 | `./data` / `./uploads` |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB` | 单文件上限 | `5` / `4096` |
| `TRUST_PROXY` | 在 Nginx 后面时设为 `1` | `1` |
| `DANMAKU_COOLDOWN_SEC` | 同一 IP 发弹幕的间隔 | `3` |

---

## 常见问题

**Q：`npm start` 报 `node:sqlite` 找不到？**
Node 版本太低。`node -v` 要 ≥ 22.5，推荐 22 LTS。

**Q：忘了后台密码怎么办？**
删掉 `data/admin.json`，重启服务，终端会打印新的随机密码；或者
`node tools/hash-password.js '新密码' --write` 直接覆盖。

**Q：端口被占用？**
`.env` 里改 `PORT=8081`，或临时 `PORT=8081 npm start`。

**Q：数据在哪？换电脑怎么搬？**
把整个目录拷走就行，`data/` 和 `uploads/` 是全部家当（默认不进 Git，注意别漏）。

**Q：后台为什么没有"观测中心 / SSH 控制台"？**
那两个依赖服务器上的进程探针与 ttyd 终端，只有 Ubuntu 版提供。这里是单机版，后台只留了日志、数据库、备份这些本地能自洽的功能 (๑•̀ㅂ•́)و✧

---

<div align="center">
<sub>用 Node 内置模块搭的小站，没有框架，也没有 node_modules ♡</sub>
</div>
