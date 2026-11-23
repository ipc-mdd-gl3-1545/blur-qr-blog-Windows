#!/usr/bin/env bash
# ===================================================================
#  模糊二维码 · 博客后端 一键部署脚本（Ubuntu 26 / 24.04 / 22.04）
#
#  用法（把整个项目目录上传到服务器后执行）：
#     cd /root/blog            # 项目所在目录
#     sudo bash deploy/install.sh                      # 只装后端（Nginx 已有则手动配置）
#     sudo bash deploy/install.sh blog.example.com     # 同时配置 Nginx 反代
#
#  脚本做的事：
#    1) 检查/安装 Node.js（>= 22.5，缺则装 22 LTS）
#    2) 创建系统用户 blog，把代码同步到 /opt/blog
#    3) 生成 .env（随机后台路径 + 随机密码哈希 + 会话密钥）
#    4) 安装 systemd 服务并开机自启、崩溃自拉起
#    5) 可选：写入 Nginx 反代配置并 reload
# ===================================================================
set -eu

APP_DIR=/opt/blog
APP_USER=blog
DOMAIN=""
NO_NGINX=0
PUBLIC_MODE=0

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
die()   { red "✗ $*"; exit 1; }

# 参数解析：可传域名，也可只传开关
#   sudo bash deploy/install.sh                    # 本机监听 127.0.0.1:8080
#   sudo bash deploy/install.sh --public           # 监听 0.0.0.0:8080，直接 IP 访问（防火墙自动放行）
#   sudo bash deploy/install.sh blog.test.com      # Nginx 反代 + 域名 + 自动 HTTPS
for arg in "$@"; do
  case "$arg" in
    --no-nginx) NO_NGINX=1 ;;
    --public)   PUBLIC_MODE=1 ;;
    -*)         die "未知参数：$arg" ;;
    *)          DOMAIN="$arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy/install.sh"

blue "==> 1/6 检查系统环境"
. /etc/os-release 2>/dev/null || true
green "    系统：${PRETTY_NAME:-unknown}  $(uname -m)"
command -v systemctl >/dev/null || die "需要 systemd"

node_ok() {
  command -v node >/dev/null || return 1
  # 需要 22.13+：该版本起 node:sqlite 无需 --experimental-sqlite 参数
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&(b>13||(b===13&&c>=0)))?0:1)' 2>/dev/null
}

# 从本地 tarball 安装 Node（离线可用）：支持 .tar.gz / .tar.xz
install_node_tarball() {
  local f="$1"
  mkdir -p /usr/local/lib/nodejs
  case "$f" in
    *.tar.xz) tar -xJf "$f" -C /usr/local/lib/nodejs || return 1 ;;
    *.tar.gz) tar -xzf "$f" -C /usr/local/lib/nodejs || return 1 ;;
    *) return 1 ;;
  esac
  local d="/usr/local/lib/nodejs/$(basename "${f%.tar.*}")"
  [ -x "$d/bin/node" ] || return 1
  local b
  for b in node npm npx corepack; do
    [ -e "$d/bin/$b" ] && ln -sf "$d/bin/$b" "/usr/local/bin/$b"
  done
  hash -r
  node_ok
}

VENDOR_NODE="$(ls "$SRC_DIR"/vendor/node-*-linux-*.tar.* 2>/dev/null | head -1 || true)"

if node_ok; then
  green "    Node.js：$(node -v)（满足要求）"
else
  blue "==> 2/6 安装 Node.js 22 LTS"
  NODE_DONE=0
  # ① 优先用随包携带的离线版本（虚拟机/内网无外网时唯一可行路径）
  if [ -n "${VENDOR_NODE:-}" ]; then
    blue "    使用离线包 $(basename "$VENDOR_NODE")"
    if install_node_tarball "$VENDOR_NODE"; then NODE_DONE=1; fi
  fi
  # ② 没有离线包或装失败，走联网安装
  if [ "$NODE_DONE" -eq 0 ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 || true
    VER_LINE="$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt 2>/dev/null \
      | grep -o 'node-v22[0-9.]*-linux-x64\.tar\.xz' | head -1 || true)"
    if [ -n "${VER_LINE:-}" ]; then
      blue "    下载 ${VER_LINE}"
      TMPN=$(mktemp -d)
      if curl -fsSL --max-time 300 "https://nodejs.org/dist/latest-v22.x/${VER_LINE}" -o "$TMPN/node.tar.xz"; then
        install_node_tarball "$TMPN/node.tar.xz" && NODE_DONE=1
      fi
      rm -rf "$TMPN"
    fi
  fi
  if [ "$NODE_DONE" -eq 0 ]; then
    blue "    回退到 NodeSource 源安装"
    curl -fsSL --max-time 30 https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - >/dev/null 2>&1 || true
    apt-get install -y -qq nodejs >/dev/null 2>&1 || true
    hash -r
  fi
  node_ok || die "Node.js 安装失败。离线环境请确认 vendor/ 目录下有 node-*-linux-x64.tar.gz"
fi


blue "==> 3/6 准备运行用户与目录"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
  green "    已创建系统用户 $APP_USER"
else
  green "    用户 $APP_USER 已存在"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"

blue "==> 4/6 同步代码到 $APP_DIR"
EXCLUDES=(--exclude=.git --exclude=node_modules --exclude=_frames --exclude=.env \
          --exclude=data --exclude=uploads --exclude=.workbuddy --exclude='*.genie' \
          --exclude=dist --exclude=vendor)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "${EXCLUDES[@]}" "$SRC_DIR"/ "$APP_DIR"/
else
  # 没有 rsync 也能装（离线机器常见）：用系统自带的 tar 复制
  ( cd "$SRC_DIR" && tar -cf - "${EXCLUDES[@]}" . ) | tar -xf - -C "$APP_DIR"
fi
green "    代码已同步"

NEW_PASSWORD=""
NEW_ADMIN_PATH=""

blue "==> 5/6 生成配置 .env"
if [ -f "$APP_DIR/.env" ]; then
  green "    .env 已存在，保留现有配置（不覆盖密码）"
  ADMIN_PATH_SHOW="$(grep -E '^ADMIN_PATH=' "$APP_DIR/.env" | cut -d= -f2- || echo /manage)"
  PORT_SHOW="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2- || echo 8080)"
else
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  NEW_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")"
  NEW_ADMIN_PATH="/manage-$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")"
  NEW_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  HASH_LINE="$(cd "$APP_DIR" && node tools/hash-password.js "$NEW_PASSWORD" | grep '^ADMIN_PASSWORD_HASH=')"

  # 用 node 改写 .env（不依赖 python3 / sed，离线机器也稳）
  cat > /tmp/patch-env.js <<'JS'
const fs = require('fs');
const [file, adminPath, hash, secret] = process.argv.slice(2);
const kv = { ADMIN_PATH: adminPath, ADMIN_PASSWORD_HASH: hash, SESSION_SECRET: secret };
const out = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=/.exec(line);
  if (m && Object.prototype.hasOwnProperty.call(kv, m[1])) {
    out.push(`${m[1]}=${kv[m[1]]}`); delete kv[m[1]];
  } else out.push(line);
}
for (const k in kv) out.push(`${k}=${kv[k]}`);
fs.writeFileSync(file, out.join('\n'));
JS
  node /tmp/patch-env.js "$APP_DIR/.env" "$NEW_ADMIN_PATH" "${HASH_LINE#ADMIN_PASSWORD_HASH=}" "$NEW_SECRET"
  rm -f /tmp/patch-env.js
  chmod 600 "$APP_DIR/.env"
  ADMIN_PATH_SHOW="$NEW_ADMIN_PATH"
  PORT_SHOW="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2-)"
  green "    已生成 .env（随机后台路径 + 随机密码 + 会话密钥）"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/data"

# ---------- 公网直连模式：监听 0.0.0.0 + 放行防火墙 ----------
if [ "$PUBLIC_MODE" -eq 1 ] && [ -z "$DOMAIN" ]; then
  blue "==> 公网直连模式：监听 0.0.0.0:${PORT_SHOW}"
  sed -i "s/^HOST=.*/HOST=0.0.0.0/" "$APP_DIR/.env"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT_SHOW}/tcp" >/dev/null 2>&1 || true
    green "    已放行 ufw ${PORT_SHOW}/tcp"
  else
    green "    ufw 未启用，跳过放行（云服务器还需在安全组放行 ${PORT_SHOW}）"
  fi
fi

blue "==> 6/6 安装并启动 systemd 服务"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then NODE_BIN=/usr/bin/node; fi
sed "s#^ExecStart=.*#ExecStart=${NODE_BIN} server.js#" "$APP_DIR/deploy/blog.service" \
  > /etc/systemd/system/blog.service
chmod 644 /etc/systemd/system/blog.service
green "    node 路径：${NODE_BIN}"
systemctl daemon-reload
systemctl enable blog >/dev/null 2>&1 || true
systemctl restart blog
sleep 2

if ! systemctl is-active --quiet blog; then
  red "服务启动失败，最近日志："
  journalctl -u blog -n 40 --no-pager || true
  exit 1
fi
# 健康检查用 node 发请求（离线机器可能没有 curl）
if ! node -e "
const http=require('http');
const req=http.get('http://127.0.0.1:${PORT_SHOW}/healthz',res=>process.exit(res.statusCode===200?0:1));
req.on('error',()=>process.exit(1));
req.setTimeout(5000,()=>{req.destroy();process.exit(1);});
" 2>/dev/null; then
  red "健康检查未通过，最近日志："
  journalctl -u blog -n 40 --no-pager || true
  exit 1
fi
green "    服务已运行：http://127.0.0.1:${PORT_SHOW}"

# ---------- Nginx（可选） ----------
if [ "$NO_NGINX" -eq 0 ] && [ -n "$DOMAIN" ]; then
  blue "==> 配置 Nginx 反向代理：$DOMAIN"
  if ! command -v nginx >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null
  fi
  sed "s/__DOMAIN__/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/blog
  ln -sf /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/blog
  if [ -e /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    green "    Nginx 已生效"
    echo
    yellow_hint="下一步申请 HTTPS 证书："
    blue "    $yellow_hint"
    echo "      sudo apt install -y certbot python3-certbot-nginx"
    echo "      sudo certbot --nginx -d ${DOMAIN}"
  else
    red "Nginx 配置校验失败，请手动检查 /etc/nginx/sites-available/blog"
  fi
else
  blue "==> 跳过 Nginx（未提供域名或指定了 --no-nginx）"
fi

# ---------- 汇总 ----------
echo
green "=============================================================="
green "  部署完成"
green "=============================================================="
echo "  代码目录      $APP_DIR"
echo "  数据库        $APP_DIR/data/blog.db"
echo "  图片目录      $APP_DIR/uploads"
echo "  配置文件      $APP_DIR/.env   （改完执行 sudo systemctl restart blog）"
echo "  服务管理      systemctl status|restart|stop blog"
echo "  实时日志      journalctl -u blog -f"
echo
if [ -n "$NEW_PASSWORD" ]; then
  printf '\033[33m'
  echo "  后台地址      http://<你的域名或IP>${ADMIN_PATH_SHOW}"
  echo "  后台密码      ${NEW_PASSWORD}"
  echo
  echo "  ⚠ 密码只显示这一次，请立刻记录。忘记密码可用："
  echo "     cd $APP_DIR && node tools/hash-password.js '新密码'   然后把哈希写入 .env"
  printf '\033[0m'
else
  echo "  后台地址      http://<你的域名或IP>${ADMIN_PATH_SHOW}"
fi

if [ -n "$DOMAIN" ]; then
  echo "  网站地址      http://${DOMAIN}"
elif [ "$PUBLIC_MODE" -eq 1 ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "  网站地址      http://${LAN_IP:-<服务器IP>}:${PORT_SHOW}"
else
  echo "  网站地址      http://127.0.0.1:${PORT_SHOW}（仅本机）"
fi

if [ -z "$DOMAIN" ] && [ "$PUBLIC_MODE" -eq 0 ]; then
  echo
  echo "  提示：当前只监听本机 127.0.0.1:${PORT_SHOW}。要让外部访问，三选一："
  echo "    A) 直接 IP 访问（最快）：sudo bash deploy/install.sh --public"
  echo "    B) 域名 + Nginx + 免费 HTTPS：sudo bash deploy/install.sh blog.example.com"
  echo "    C) 没有公网 IP（家宽/VMware NAT）：用内网穿透"
  echo "       sudo bash deploy/tunnel.sh"
elif [ -z "$DOMAIN" ] && [ "$PUBLIC_MODE" -eq 1 ]; then
  echo
  echo "  提醒：VMware NAT 模式下，宿主机/局域网可直接访问上面的地址；"
  echo "        要让真正的互联网访客访问，需要在 VMware 做端口映射 + 路由器端口转发，"
  echo "        或直接跑内网穿透：sudo bash deploy/tunnel.sh"
fi
echo
