#!/usr/bin/env bash
# ===================================================================
#  从 GitHub 拉取 Node 版并同步到 /opt/blog（只同步受版本控制的文件）
#  仓库拆分后：源码在 blur-qr-blog-Windows/ 子目录，站点目录仍保持扁平的 /opt/blog
#  - 不会改动 .env（后台密码 / 会话密钥）
#  - 不会改动 data/（文章数据库）和 uploads/（上传的图片）
#  用法：sudo bash git-init.sh
# ===================================================================
set -eu
export GIT_TERMINAL_PROMPT=0   # 需要凭据时直接报错，避免脚本卡在输入提示

APP=/opt/blog
REPO="https://github.com/ipc-mdd-gl3-1545/blur-qr-blog.git"
BRANCH=main
HOST_PROXY="192.168.5.3:7897"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
die()   { red "✗ $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
[ -d "$APP" ] || die "找不到 $APP，请先完成首次部署"

# ---------- 1. 依赖 ----------
blue "==> 1/5 检查 git 与 curl"
NEED=""
command -v git  >/dev/null 2>&1 || NEED="$NEED git"
command -v curl >/dev/null 2>&1 || NEED="$NEED curl"
if [ -n "$NEED" ]; then
  blue "    需要安装：$NEED"
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $NEED >/dev/null
fi
green "    $(git --version)"

# ---------- 2. 连通性 ----------
blue "==> 2/5 测试能否访问 GitHub"
GH_OK=0
try_direct() {
  for i in 1 2 3; do
    curl -fsS --max-time 8 -o /dev/null https://github.com 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
try_proxy() {
  for i in 1 2 3; do
    curl -fsS --max-time 8 -x "http://$HOST_PROXY" -o /dev/null https://github.com 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
if try_direct; then
  green "    直连 GitHub 正常"
  GH_OK=1
else
  blue "    直连不通，尝试走宿主机代理 $HOST_PROXY"
  if try_proxy; then
    git config --global http.https://github.com.proxy "http://$HOST_PROXY"
    green "    已配置代理：http://$HOST_PROXY"
    GH_OK=1
  else
    red "    直连与代理均不可用"
  fi
fi
if [ "$GH_OK" -ne 1 ]; then
  red ""
  red "  解决办法（任选其一）："
  red "   A. 在 Windows 的 Clash Verge 里打开「允许局域网连接 / Allow LAN」，再重跑本脚本"
  red "   B. 在 Ubuntu 里给 git 配一个可用代理："
  red "      git config --global http.https://github.com.proxy http://<代理地址>:<端口>"
  exit 1
fi

# ---------- 3. 接入仓库 ----------
blue "==> 3/5 接入仓库并同步代码"
SRC=/opt/blog-src
blue "    源码仓库 $SRC → 站点目录 $APP"
if [ -d "$SRC/.git" ]; then
  cd "$SRC"
  git remote set-url origin "$REPO" 2>/dev/null || git remote add origin "$REPO"
else
  rm -rf "$SRC"
  git clone --branch "$BRANCH" "$REPO" "$SRC" || die "拉取失败：仓库可能是私有的（需要 token/Deploy Key），或网络不稳定。详见 GIT.md 第 7 节"
  cd "$SRC"
fi
git config --global --add safe.directory "$SRC" 2>/dev/null || true
git config core.autocrlf false
if ! git fetch --all --prune --tags; then
  die "拉取失败：仓库可能是私有的（需要 token/Deploy Key），或网络不稳定。详见 GIT.md 第 7 节"
fi
git reset --hard "origin/$BRANCH"
green "    当前版本：$(git log -1 --oneline)"

blue "    同步 $SRC/blur-qr-blog-Windows/ → $APP（.env / data / uploads / videos 不动）"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude '.git' --exclude '.env' --exclude 'data/' --exclude 'uploads/' --exclude 'videos/' \
        "$SRC/blur-qr-blog-Windows/" "$APP/"
else
  tar -C "$SRC/blur-qr-blog-Windows" --exclude=.git --exclude=.env --exclude=data \
      --exclude=uploads --exclude=videos -cf - . | tar -C "$APP" -xf -
fi
chown -R blog:blog "$APP" 2>/dev/null || true

# ---------- 4. 重启服务 ----------
blue "==> 4/5 重启博客服务"
systemctl restart blog
sleep 2
if systemctl is-active --quiet blog; then
  green "    blog 服务运行中"
else
  red "    服务启动失败，最近日志："
  journalctl -u blog -n 30 --no-pager || true
  exit 1
fi

# ---------- 5. 自检 ----------
blue "==> 5/5 健康检查"
if node -e "const http=require('http');http.get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
  green "    /healthz 返回 200"
else
  red "    健康检查未通过，请查看 journalctl -u blog -n 30"
fi

echo
green "=============================================================="
green "  服务器已接入 GitHub"
green "=============================================================="
echo "  代码目录    $APP"
echo "  当前版本    $(git log -1 --oneline)"
echo "  数据与配置  .env / data/ / uploads/ 均未改动（已被 .gitignore 忽略）"
echo
echo "  以后更新：bash $0   （或 cd /opt/blog-src && git pull，再同步 blur-qr-blog-Windows/）"
echo "  查看历史：cd /opt/blog-src && git log --oneline -10"
echo "  回滚版本：cd /opt/blog-src && git fetch --tags && git reset --hard v1.0.0 && bash $0"
echo
