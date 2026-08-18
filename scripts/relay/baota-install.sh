#!/usr/bin/env bash
# 在宝塔终端运行：安装 relay 进程 + 部署手机网页到站点根目录
set -e

INSTALL_DIR="${INSTALL_DIR:-/www/codemux-relay}"
SITE_ROOT="${SITE_ROOT:-/www/wwwroot/relay.fumi-blog.top}"
cd "$INSTALL_DIR"

echo "==> Relay 安装目录: $(pwd)"
test -f companion-relay.mjs || { echo "缺少 companion-relay.mjs"; exit 1; }
test -f companion-relay-bridge.mjs || { echo "缺少 companion-relay-bridge.mjs"; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo "请先在宝塔软件商店安装 Node.js 20+"
  exit 1
fi

echo "==> Node $(node -v)"
npm install --omit=dev

PM2_BIN=""
if command -v pm2 >/dev/null 2>&1; then
  PM2_BIN="pm2"
elif [ -x "$(npm prefix -g)/bin/pm2" ]; then
  PM2_BIN="$(npm prefix -g)/bin/pm2"
else
  npm install -g pm2
  PM2_BIN="$(npm prefix -g)/bin/pm2"
fi

"$PM2_BIN" delete codemux-relay 2>/dev/null || true
"$PM2_BIN" start companion-relay.mjs --name codemux-relay -- --port 8787
"$PM2_BIN" save

echo ""
echo "==> Relay 本机测试"
curl -sf http://127.0.0.1:8787 && echo "" || echo "(curl 127.0.0.1:8787 失败，执行: $PM2_BIN logs codemux-relay)"

if [ -d mobile-web ]; then
  echo ""
  echo "==> 部署手机网页到 $SITE_ROOT"
  mkdir -p "$SITE_ROOT"
  cp -a mobile-web/. "$SITE_ROOT/"
  chown -R www:www "$SITE_ROOT" 2>/dev/null || true
  echo "    已复制 index.html 与 assets/"
else
  echo ""
  echo "==> 未找到 mobile-web/，跳过网页部署"
fi

echo ""
echo "=========================================="
echo "  宝塔面板必做（否则只能看到 relay 一行字）"
echo "=========================================="
echo "1. 网站 -> relay.fumi-blog.top -> 网站目录 设为:"
echo "   $SITE_ROOT"
echo "2. 删除「整站反向代理到 8787」的配置（若有）"
echo "3. 网站 -> 配置文件，在 server { } 内加入 baota-nginx-snippet.conf 内容"
echo "   （仅 /ws 走 8787，其余走静态手机页）"
echo "4. SSL 证书配好后，访问 https://relay.fumi-blog.top 应看到配对页"
echo "5. 桌面 CodeMUX 启用中继 -> 刷新二维码 -> 手机扫码"
echo "=========================================="
