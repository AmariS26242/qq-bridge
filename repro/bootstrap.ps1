<#
  bootstrap.ps1 —— 把「可复现交付包」落成一台新机器上的可运行 QQ 端

  它做六件事，顺序即依赖：
    1. 校验 MANIFEST.sha256（确认包没被改坏）
    2. 把 12 个占位符替换成这台机器的真实值（用户名/工作区/QQ 号/node 路径/token）
    3. 铺目录：qq-bridge/、qqbot/、dsh-profile/、config.json、SnowLuma config
    4. 装依赖（npm ci）
    5. 建 ~/.dsh/plugins 两个 Junction（指向工作区插件，改工作区即生效）
    6. 打印「接下来手动做哪 3 件事」

  用法（在解压出来的包根目录）:
    pwsh -File bootstrap.ps1 -Workspace C:\example\bots -OwnerQQ 100000001 -BotQQ 100000002
    pwsh -File bootstrap.ps1 -Workspace C:\example\bots -OwnerQQ 1 -BotQQ 2 -SnowLumaDir C:\example\bots\SnowLuma
    pwsh -File bootstrap.ps1 -VerifyOnly            # 只校验包完整性

  说明：本脚本不碰网络之外的任何系统设置；不写注册表；不改计划任务。
#>
[CmdletBinding()]
param(
  [string]$Workspace,
  [string]$OwnerQQ,
  [string]$BotQQ,
  [string]$SnowLumaDir,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'qqbridge',
  [switch]$VerifyOnly,
  [switch]$SkipInstall,
  [switch]$SkipVerify,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$stage = Join-Path ([IO.Path]::GetTempPath()) ("qqbootstrap-" + [guid]::NewGuid().ToString('N').Substring(0,8))

function Step($m) { Write-Host "[bootstrap] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

# ---------- 1. 校验 ----------
function Verify-Manifest {
  $mf = Join-Path $Root 'MANIFEST.sha256'
  if (-not (Test-Path $mf)) { Die "找不到 MANIFEST.sha256，包不完整" }
  $bad = 0; $miss = 0; $n = 0
  Get-Content $mf -Encoding utf8 | Where-Object { $_.Trim() } | ForEach-Object {
    $n++
    $hash, $rel = $_ -split '\s+', 2
    $p = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path $p)) { $miss++; Write-Host "  缺失: $rel" -ForegroundColor Yellow; return }
    $actual = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $hash.ToLower()) { $bad++; Write-Host "  校验失败: $rel" -ForegroundColor Red; return }
    # 顺带检查占位符残留是否合理（不允许出现本机真实的 QQ 号以外的意外）
  }
  Write-Host "[bootstrap] 清单校验：$n 个文件，缺失 $miss，损坏 $bad"
  if ($miss -or $bad) { Die "包完整性不通过，先用 -SkipVerify 强制继续或重新获取交付包" }
}

if (-not $SkipVerify) { Step "校验包完整性"; Verify-Manifest }
if ($VerifyOnly) { Step "只校验模式，结束"; exit 0 }

# ---------- 2. 参数与前置检查 ----------
if (-not $Workspace) { Die "必须指定 -Workspace（目标工作区根目录，例如 C:\example\bots）" }
if (-not $OwnerQQ)   { Die "必须指定 -OwnerQQ（主人 QQ 号）" }
if (-not $BotQQ)     { Die "必须指定 -BotQQ（机器人小号 QQ 号）" }
if ($OwnerQQ -eq $BotQQ) { Die "OwnerQQ 与 BotQQ 不能相同" }

$Workspace = [IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Path $Workspace -Force | Out-Null }
$BridgeDir = Join-Path $Workspace 'qq-bridge'
$QqbotDir  = Join-Path $Workspace 'qqbot'

$nodeVer = $null
$sysNode = (Get-Command node -ErrorAction SilentlyContinue)
if ($sysNode) { $nodeVer = (& node -v) -replace '^v','' }
Step ("Node: {0}" -f ($(if ($nodeVer) { $nodeVer } else { '未找到（后续装依赖/跑脚本会失败）' })))
if ($nodeVer) {
  $v = [version]($nodeVer -replace '-.*$','')
  if ($v -lt [version]'22.13.0') { Warn "Node $nodeVer < 22.13，qq-bridge 要求 >=22.13.0（engines 已声明）" }
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
$dshVer = if ($dsh) { ((& $dsh.Source --version 2>$null) -join ' ').Trim() } else { $null }
$expected = 'unknown'
$baselineFile = Join-Path $Root 'BASELINE.json'
if (Test-Path $baselineFile) { $expected = (Get-Content $baselineFile -Raw | ConvertFrom-Json).dshVerified }
if (-not $dsh) { Warn "PATH 里没有 dsh，装好 DeepSeek Harness 后重跑本脚本" }
elseif ($dshVer -ne $expected) { Warn "DSH 版本 $dshVer 与交付包验证版本 $expected 不一致，MCP/RPC 兼容性需先跑 npm run self-test 确认" }

# DSH 自带 node（MCP 子进程必须用它，见 5.3/5.4 章）
$dshRuntimeNode = $null
if ($dsh) {
  $dshExe = $dsh.Source
  $cand = @()
  $p = Split-Path -Parent $dshExe
  for ($i = 0; $i -lt 4 -and $p; $i++) { $cand += $p; $p = Split-Path -Parent $p }
  foreach ($c in $cand) {
    $guess = Join-Path $c 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $guess) { $dshRuntimeNode = $guess; break }
    $guess2 = Join-Path $c 'runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $guess2) { $dshRuntimeNode = $guess2; break }
  }
}
if (-not $dshRuntimeNode) {
  Warn "未能定位 DSH 自带 node.exe，退回系统 node（可能触发 MCP 启动失败，见 5.4 章）"
  $dshRuntimeNode = if ($sysNode) { (Get-Command node).Source } else { 'node' }
}

# OneBot token（若给了 SnowLuma 目录，直接读它的账号配置）
$httpToken = '__ONEBOT_TOKEN__'; $wsToken = '__ONEBOT_TOKEN__'
if ($SnowLumaDir) {
  $ob = Join-Path $SnowLumaDir "config\onebot_$BotQQ.json"
  if (Test-Path $ob) {
    $j = Get-Content $ob -Raw | ConvertFrom-Json
    $httpToken = $j.networks.httpServers[0].accessToken
    $wsToken   = $j.networks.wsServers[0].accessToken
    Step "已从 SnowLuma 账号配置读到 OneBot token"
  } else { Warn "没找到 $ob，config.json 里的 token 先留占位，稍后手工填" }
}

# ---------- 3. 铺目录 + 占位符实例化 ----------
Step "铺目录到 $Workspace"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

$escWs  = $Workspace.Replace('\','\\')
$fwdWs  = $Workspace.Replace('\','/')
$prof   = $env:USERPROFILE
$map = [ordered]@{
  '__USERPROFILE_ESC__' = $prof.Replace('\','\\')
  '__USERPROFILE_FWD__' = $prof.Replace('\','/')
  '__USERPROFILE__'     = $prof
  '__USERNAME__'        = $env:USERNAME
  '__WORKSPACE_ESC__'   = $escWs
  '__WORKSPACE_FWD__'   = $fwdWs
  '__WORKSPACE__'       = $Workspace
  '__DSH_RUNTIME_NODE__' = $dshRuntimeNode
  '__OWNER_QQ__'        = $OwnerQQ
  '__BOT_QQ__'          = $BotQQ
  '__ONEBOT_TOKEN__'    = $httpToken
  '__SNOWLUMA_WEBUI_PASSWORD__' = $(if ($env:SNOWLUMA_WEBUI_PASSWORD) { $env:SNOWLUMA_WEBUI_PASSWORD } else { '__SET_SNOWLUMA_WEBUI_PASSWORD__' })
}

function Copy-Tree([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) { Warn "包内缺少 $src"; return }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  Get-ChildItem $src -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\')
    $target = Join-Path $dst $rel
    if ($_.PSIsContainer) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
    else {
      $d = Split-Path -Parent $target
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
      Copy-Item $_.FullName $target -Force
    }
  }
}

function Instantiate-Tree([string]$dir) {
  $exts = @('.js','.mjs','.cjs','.json','.jsonc','.md','.yml','.yaml','.html','.css','.ps1','.bat','.cmd','.vbs','.txt','.java','.xml','.jsonl','.example')
  $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
  $utf8NoBom  = New-Object System.Text.UTF8Encoding($false)
  $changed = 0
  Get-ChildItem $dir -Recurse -File -Force | ForEach-Object {
    if ($exts -notcontains $_.Extension.ToLower() -and $_.Name -notlike '*.example*') { return }
    $bytes = [IO.File]::ReadAllBytes($_.FullName)
    $text = $null; $enc = $utf8NoBom
    try { $text = $utf8Strict.GetString($bytes) }
    catch { return }
    $orig = $text
    foreach ($k in $map.Keys) { if ($text.Contains($k)) { $text = $text.Replace($k, [string]$map[$k]) } }
    if ($text -ne $orig) { [IO.File]::WriteAllBytes($_.FullName, $enc.GetBytes($text)); $changed++ }
  }
  return $changed
}

# qq-bridge
Copy-Tree (Join-Path $Root 'qq-bridge') $BridgeDir
# qqbot
Copy-Tree (Join-Path $Root 'qqbot') $QqbotDir
# profile
$profDst = Join-Path $DshHome "profiles\$Profile"
Copy-Tree (Join-Path $Root 'dsh-profile') $profDst
# config.json（从模板实例化）
Copy-Item (Join-Path $Root 'config.template.json') (Join-Path $BridgeDir 'config.json') -Force
# qqbot.local.json
$qlTpl = Join-Path $Root 'qqbot\qqbot.local.example.json'
if (Test-Path $qlTpl) { Copy-Item $qlTpl (Join-Path $QqbotDir 'qqbot.local.json') -Force }
# SnowLuma 配置
if ($SnowLumaDir) {
  $cfgDir = Join-Path $SnowLumaDir 'config'
  if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }
  Get-ChildItem (Join-Path $Root 'snowluma-config') -File | ForEach-Object {
    $dst = Join-Path $cfgDir $_.Name
    if ((Test-Path $dst) -and -not $Force) { Warn "SnowLuma 已有 $($_.Name)，跳过（-Force 覆盖）" }
    else { Copy-Item $_.FullName $dst -Force }
  }
}

Step "替换占位符"
foreach ($d in @($BridgeDir, $QqbotDir, $profDst)) {
  if (Test-Path $d) { $n = Instantiate-Tree $d; Step ("  {0,-40} {1} 文件" -f (Split-Path -Leaf $d), $n) }
}

# qqbot.local.json：把 dsh.cmd 换成这台机器上真实的 dsh（占位符只能给形状，给不了路径）
$ql = Join-Path $QqbotDir 'qqbot.local.json'
if ((Test-Path $ql) -and $dsh) {
  try {
    $o = Get-Content $ql -Raw | ConvertFrom-Json
    if (-not $o.dsh) { $o | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
    $o.dsh.cmd = ($dsh.Source -replace '\\','/')
    $o.dsh.profile = $Profile
    ($o | ConvertTo-Json -Depth 12) | Set-Content $ql -Encoding utf8
    Step ("  已回填 qqbot.local.json 的 dsh.cmd = {0}" -f $o.dsh.cmd)
  } catch { Warn "回填 dsh.cmd 失败：$($_.Exception.Message)" }
}

# 残留占位符检查（只认交付包自己定义的清单，避免 __proto__ / __snowluma__ 之类代码标识符假阳性）
$knownPh = @(
  '__USERNAME__','__USERPROFILE__','__USERPROFILE_ESC__','__USERPROFILE_FWD__',
  '__WORKSPACE__','__WORKSPACE_ESC__','__WORKSPACE_FWD__','__DSH_RUNTIME_NODE__',
  '__OWNER_QQ__','__BOT_QQ__','__ONEBOT_TOKEN__',
  '__SNOWLUMA_WEBUI_PASSWORD__','__SET_SNOWLUMA_WEBUI_PASSWORD__',
  '__SNOWLUMA_PASSWORD_HASH__','__SNOWLUMA_PASSWORD_SALT__'
)
$needManual = @{
  '__ONEBOT_TOKEN__' = 'SnowLuma OneBot token（第 1 件手工事里填）'
  '__SNOWLUMA_WEBUI_PASSWORD__' = 'SnowLuma WebUI 口令'
  '__SET_SNOWLUMA_WEBUI_PASSWORD__' = 'SnowLuma WebUI 口令'
  '__SNOWLUMA_PASSWORD_HASH__' = 'SnowLuma 口令散列（WebUI 里设了口令后由 SnowLuma 自己写）'
  '__SNOWLUMA_PASSWORD_SALT__' = 'SnowLuma 口令盐（同上）'
}
$hits = @{}
Get-ChildItem $BridgeDir, $QqbotDir, $profDst -Recurse -File -Include *.js,*.mjs,*.json,*.yml,*.html -ErrorAction SilentlyContinue |
  Select-String -Pattern ($knownPh -join '|') -AllMatches -ErrorAction SilentlyContinue |
  ForEach-Object { foreach ($m in $_.Matches) { $hits[$m.Value] = 1 + ($hits[$m.Value] ?? 0) } }
if ($hits.Count -gt 0) {
  $unexpected = @($hits.Keys | Where-Object { -not $needManual.ContainsKey($_) })
  if ($unexpected.Count -gt 0) {
    Warn ("这些占位符没被替换，说明安装参数不全：{0}" -f ($unexpected -join ', '))
  }
  $expect = @($hits.Keys | Where-Object { $needManual.ContainsKey($_) })
  if ($expect.Count -gt 0) {
    Write-Host '  留作手工填的机密（属预期）：' -ForegroundColor DarkGray
    foreach ($k in $expect) { Write-Host ("    {0,-32} {1} 处 — {2}" -f $k, $hits[$k], $needManual[$k]) -ForegroundColor DarkGray }
  }
}

# ---------- 4. 依赖 ----------
# 注意：这台机器上没有 npm（node 来自 DSH 运行时，只带 pnpm）。所以 pnpm 优先，npm 兜底。
if (-not $SkipInstall) {
  $pmExe = $null; $pmName = $null
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpmCmd) {
    $cand = Join-Path $env:USERPROFILE '.dsh\runtimes\bin\pnpm.cmd'
    if (Test-Path $cand) { $pnpmCmd = Get-Item $cand }
  }
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npmCmd -and $sysNode) {
    $cand = Join-Path (Split-Path (Get-Command node).Source) 'npm.cmd'
    if (Test-Path $cand) { $npmCmd = Get-Item $cand }
  }
  if ($pnpmCmd) { $pmExe = $pnpmCmd.Source; $pmName = 'pnpm' }
  elseif ($npmCmd) { $pmExe = $npmCmd.Source; $pmName = 'npm' }

  if (-not $pmExe) {
    Warn '本机既没有 pnpm 也没有 npm，依赖装不了：装 Node 22 LTS（带 npm）或 pnpm 后重跑，或手工在有网机器上装好 node_modules 再拷过来'
  } else {
    Step ("{0} install（在 {1}）" -f $pmName, $BridgeDir)
    Push-Location $BridgeDir
    try {
      if ($pmName -eq 'pnpm') {
        $hasLock = Test-Path (Join-Path $BridgeDir 'pnpm-lock.yaml')
        if ($hasLock) { & $pmExe install --frozen-lockfile } else { & $pmExe install }
        if ($LASTEXITCODE -ne 0) { Warn "pnpm install 失败（退出码 $LASTEXITCODE）：检查网络/镜像（pnpm config set registry https://registry.npmmirror.com）" }
      } else {
        $hasLock = Test-Path (Join-Path $BridgeDir 'package-lock.json')
        if ($hasLock) { & $pmExe ci --no-audit --no-fund } else { & $pmExe install --no-audit --no-fund }
        if ($LASTEXITCODE -ne 0) { Warn "npm 安装失败（退出码 $LASTEXITCODE）：检查网络/镜像" }
      }
    } finally { Pop-Location }
  }
} else { Warn "跳过依赖安装（-SkipInstall）" }

# ---------- 5. Junction ----------
Step "建立 ~/.dsh/plugins Junction"
$pluginsDir = Join-Path $DshHome 'plugins'
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
foreach ($name in @('qq-mode-console', 'qq-agent-presets')) {
  $src = Join-Path $BridgeDir "plugins\$name"
  $dst = Join-Path $pluginsDir $name
  if (-not (Test-Path $src)) { Warn "缺插件目录 $src"; continue }
  if (Test-Path $dst) {
    $item = Get-Item $dst -Force
    if ($item.LinkType) { Write-Host "  已存在联接: $name" -ForegroundColor DarkGray }
    elseif ($Force) { Remove-Item $dst -Recurse -Force }
    else { Warn "$dst 已存在且不是联接，跳过（-Force 可替换）"; continue }
  }
  if (-not (Test-Path $dst)) {
    & cmd /c mklink /J "$dst" "$src" | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  已建 Junction: $name" } else { Warn "建 Junction 失败，可手工: mklink /J `"$dst`" `"$src`"" }
  }
}

# ---------- 6. 收尾 ----------
Write-Host ''
Write-Host '================ 落地完成，还剩 3 件手工事 ================' -ForegroundColor Green
Write-Host "1) SnowLuma：首次启动后在 WebUI 里设口令、建 $BotQQ 的 OneBot 账号（HTTP 3000 / WS 3001），"
Write-Host "   然后把 token 填进 <WS>\qq-bridge\config.json 的 snowluma.accessToken 与 qqbot\qqbot.local.json 的 snowluma.password"
Write-Host "2) 语音（可选）：python -m venv <WS>\qq-bridge\.venv-tts; .\.venv-tts\Scripts\pip install edge-tts"
Write-Host "   ffmpeg/ffprobe 放进 PATH 或 config 的 voiceTts.exe"
Write-Host "3) 自检：cd <WS>\qq-bridge; pnpm run self-test（没 pnpm 就 npm run self-test）; node scripts\doctor.mjs"
Write-Host ''
Write-Host "详细步骤见 docs\guides\QQ_CHANGES_VS_UPSTREAM.md（第 8 章落地清单、第 9 章验收）" -ForegroundColor Gray
