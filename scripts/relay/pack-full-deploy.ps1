# 构建统一网页端 + 打包 relay 与中继部署包（含 web，供跨网扫码）
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Out = Join-Path $Root 'codemux-relay-full-deploy.zip'

Write-Host "==> 构建统一网页端..."
Set-Location $Root
npm run build:web
if ($LASTEXITCODE -ne 0) { throw 'build:web failed' }
$WebSrc = Join-Path $Root 'dist-web'
if (-not (Test-Path (Join-Path $WebSrc 'index.html'))) {
  throw "dist-web 构建失败"
}

$staging = Join-Path $env:TEMP "codemux-relay-full-deploy"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging 'web') | Out-Null

Copy-Item (Join-Path $Root 'scripts\companion-relay.mjs') (Join-Path $staging 'companion-relay.mjs')
Copy-Item (Join-Path $Root 'scripts\companion-relay-bridge.mjs') (Join-Path $staging 'companion-relay-bridge.mjs')
Copy-Item (Join-Path $Root 'scripts\relay\package.json') (Join-Path $staging 'package.json')
Copy-Item (Join-Path $Root 'scripts\relay\baota-install.sh') (Join-Path $staging 'baota-install.sh')
Copy-Item (Join-Path $Root 'scripts\relay\baota-nginx-snippet.conf') (Join-Path $staging 'baota-nginx-snippet.conf')
Copy-Item -Recurse (Join-Path $WebSrc '*') (Join-Path $staging 'web')

foreach ($sh in @('baota-install.sh')) {
  $path = Join-Path $staging $sh
  $text = [IO.File]::ReadAllText($path) -replace "`r`n", "`n" -replace "`r", "`n"
  [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
}

if (Test-Path $Out) { Remove-Item -Force $Out }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $Out
Remove-Item -Recurse -Force $staging

Write-Host ""
Write-Host "已打包: $Out"
Write-Host ""
Write-Host "宝塔操作:"
Write-Host "  1. 文件 -> /www/codemux-relay 上传并解压此 zip"
Write-Host "  2. 终端: cd /www/codemux-relay && sed -i 's/\r$//' baota-install.sh && bash baota-install.sh"
Write-Host "  3. 网站 -> relay.fumi-blog.top -> 删除整站反向代理"
Write-Host "  4. 配置文件 -> 粘贴 baota-nginx-snippet.conf 内容"
Write-Host "  5. Open https://relay.fumi-blog.top - should show pairing page"
