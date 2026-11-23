#!/usr/bin/env bash
# ===================================================================
#  内网穿透：让没有公网 IP 的机器（VMware 虚拟机 / 家宽）也能被外网访问
#
#  用法：
#     sudo bash deploy/tunnel.sh
#         → 免费临时隧道（Cloudflare Quick Tunnel），立刻得到一个
#           https://xxxx.trycloudflare.com 地址，重启后会变
#
#     sudo bash deploy/tunnel.sh --token <TUNNEL_TOKEN>
#         → 固定域名的正式隧道（Cloudflare 后台建隧道拿 token，
#           地址永久不变，推荐长期使用）
#
#  要求：机器能访问外网（能 curl 到 github.com）
# ===================================================================
set -eu

APP_DIR=/opt/blog
SERVICE=blog-tunnel
MODE=quick
TOKEN=""

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
die()   { red "✗ $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; MODE=token; shift 2 ;;
    -*)      die "未知参数：$1" ;;
    *)       shift ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy/tunnel.sh"

PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
PORT="${PORT:-8080}"
command -v curl >/dev/null || { apt-get update -qq; apt-get install -y -qq curl ca-certificates >/dev/null; }

# ---------- 1. 安装 cloudflared ----------
if ! command -v cloudflared >/dev/null 2>&1; then
  blue "==> 安装 cloudflared"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  CF_ARCH=amd64 ;;
    aarch64) CF_ARCH=arm64 ;;
    *) die "不支持的架构：$ARCH" ;;
  esac
  TMP=$(mktemp -d)
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o "$TMP/cloudflared" || die "下载 cloudflared 失败，请检查网络"
  install -m 755 "$TMP/cloudflared" /usr/local/bin/cloudflared
  rm -rf "$TMP"
  green "    $(cloudflared --version 2>&1 | head -1)"
fi

# ---------- 2. 写 systemd 服务 ----------
blue "==> 配置隧道服务（后端端口 ${PORT}）"
if [ "$MODE" = token ]; then
  [ -n "$TOKEN" ] || die "缺少 TUNNEL_TOKEN"
  cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Cloudflare Tunnel for blog
After=network-online.target blog.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token ${TOKEN}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=multi-user.target
EOF
else
  cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Cloudflare Quick Tunnel for blog
After=network-online.target blog.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null 2>&1 || true
systemctl restart ${SERVICE}
sleep 6

if ! systemctl is-active --quiet ${SERVICE}; then
  red "隧道启动失败，日志："
  journalctl -u ${SERVICE} -n 30 --no-pager || true
  exit 1
fi

# ---------- 3. 抓出公网地址 ----------
echo
green "=============================================================="
if [ "$MODE" = token ]; then
  green "  隧道已启动（固定域名）"
  green "=============================================================="
  echo "  访问地址：你在 Cloudflare 后台给该隧道配置的域名"
  echo "  （Public Hostname 里把服务指向 http://localhost:${PORT}）"
else
  URL=""
  for _ in $(seq 1 15); do
    URL="$(journalctl -u ${SERVICE} --no-pager -o cat 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$URL" ] && break
    sleep 2
  done
  if [ -n "$URL" ]; then
    green "  公网地址（临时，重启会变）"
    green "=============================================================="
    printf '\033[33m  %s\033[0m\n' "$URL"
    echo
    echo "  后台入口：${URL}<.env 里的 ADMIN_PATH>"
    echo "  注意：cloudflared 快速隧道地址不固定，长期用建议换成 --token 固定域名隧道。"
  else
    green "  隧道已运行，但还没解析出地址"
    green "=============================================================="
    echo "  稍等几秒执行：journalctl -u ${SERVICE} -f"
    echo "  日志里会打印 https://xxxx.trycloudflare.com"
  fi
fi
echo
echo "  隧道状态   systemctl status ${SERVICE}"
echo "  隧道日志   journalctl -u ${SERVICE} -f"
echo "  关闭隧道   sudo systemctl disable --now ${SERVICE}"
echo
