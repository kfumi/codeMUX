# 本机 CodeMUX：写入 relay 端点配置 + 安装 relay 依赖（中继进程需部署在 VPS）
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

Set-Location $Root
Write-Host "==> 安装 relay 依赖..."
Push-Location (Join-Path $Root 'scripts\relay')
npm install --omit=dev
Pop-Location

Write-Host "==> 写入桌面 config.json (relay.fumi-blog.top:443 + TLS)..."
node (Join-Path $Root 'scripts\relay\configure-desktop.mjs')

Write-Host ""
Write-Host "==> 本机桌面配置已完成。"
Write-Host "    请在域名 DNS 添加:  relay.fumi-blog.top  ->  47.108.233.140  (与 www 同机)"
Write-Host "    然后运行:  powershell -File scripts\relay\pack-for-vps.ps1"
Write-Host "    将 zip 上传到 VPS 并执行 deploy-on-vps.sh"
Write-Host "    最后在 CodeMUX 移动伴侣中: 启用中继 -> 刷新二维码 -> 手机扫码"
