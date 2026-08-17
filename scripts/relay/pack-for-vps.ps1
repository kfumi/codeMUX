# 打包 relay 部署文件，便于 scp 到 VPS
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Out = Join-Path $Root 'codemux-relay-deploy.zip'

$staging = Join-Path $env:TEMP "codemux-relay-deploy"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item (Join-Path $Root 'scripts\companion-relay.mjs') (Join-Path $staging 'companion-relay.mjs')
Copy-Item (Join-Path $Root 'scripts\relay\package.json') (Join-Path $staging 'package.json')
Copy-Item (Join-Path $Root 'scripts\relay\deploy-on-vps.sh') (Join-Path $staging 'deploy-on-vps.sh')
Copy-Item (Join-Path $Root 'scripts\relay\baota-install.sh') (Join-Path $staging 'baota-install.sh')

# 强制 shell 脚本为 Unix 换行，避免 Linux 上 pipefail\r 报错
foreach ($sh in @('baota-install.sh', 'deploy-on-vps.sh')) {
  $path = Join-Path $staging $sh
  if (Test-Path $path) {
    $text = [IO.File]::ReadAllText($path) -replace "`r`n", "`n" -replace "`r", "`n"
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
  }
}

if (Test-Path $Out) { Remove-Item -Force $Out }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $Out
Remove-Item -Recurse -Force $staging

Write-Host "已打包: $Out"
Write-Host ""
Write-Host "上传到 VPS 示例:"
Write-Host "  scp $Out root@47.108.233.140:/tmp/"
Write-Host "  ssh root@47.108.233.140"
Write-Host "  cd /tmp && unzip -o codemux-relay-deploy.zip -d codemux-relay && cd codemux-relay && bash deploy-on-vps.sh"
