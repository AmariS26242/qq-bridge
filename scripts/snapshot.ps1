<#
.SYNOPSIS
    qq-bridge 改动前快照 —— 用 zip 替代 git 的"回滚点"。

.DESCRIPTION
    只打包真正需要回滚的源码/配置（约 9 MB），排除运行时大目录：
      state/ (309 MB)  node_modules/ (26 MB)  tmp/  audio/  .snapshots/  *.log  *.bak*
    config.json 含 token 等凭据，默认不进快照（要回滚配置请单独手工备份）。

    背景：本机无 git 且 github.com 不可达，故用 zip 快照兜底。
    将来若装上 git，可执行 `git init` 后弃用本脚本，历史快照仍可解压对比。

.PARAMETER List
    列出已有快照（按时间倒序）。

.PARAMETER Prune
    只保留最近 N 份快照，删除更旧的。默认 10。

.PARAMETER Note
    可选的备注，写进快照文件名，例如 -Note before-bridge-edit。

.EXAMPLE
    .\scripts\snapshot.ps1
    .\scripts\snapshot.ps1 -Note before-dashboard-route
    .\scripts\snapshot.ps1 -List
    .\scripts\snapshot.ps1 -Prune 5
#>
[CmdletBinding(DefaultParameterSetName = 'Create')]
param(
    [Parameter(ParameterSetName = 'List')]
    [switch]$List,

    [Parameter(ParameterSetName = 'Prune')]
    [int]$Prune = 10,

    [Parameter(ParameterSetName = 'Create')]
    [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root    = Split-Path -Parent $PSScriptRoot          # qq-bridge/
$snapDir = Join-Path $root '.snapshots'

# 整个目录排除
$excludeDirs = @('node_modules', 'state', 'tmp', '.snapshots', '.git', 'audio', 'android')
# 文件名模式排除
$excludeFiles = @('*.log', '*.bak', '*.bak-*', 'config.json')
# 单文件超过此大小直接跳过（防意外大包）
$maxFileMB = 5

function Get-Snapshots {
    if (-not (Test-Path $snapDir)) { return @() }
    Get-ChildItem -Path $snapDir -Filter '*.zip' -File |
        Sort-Object LastWriteTime -Descending
}

switch ($PSCmdlet.ParameterSetName) {

    'List' {
        $snaps = @(Get-Snapshots)
        if ($snaps.Count -eq 0) {
            Write-Output "没有快照。先运行： .\scripts\snapshot.ps1"
            return
        }
        $snaps |
            Select-Object @{n = 'Name'; e = { $_.Name } },
                          @{n = 'MB';   e = { [math]::Round($_.Length / 1MB, 1) } },
                          @{n = 'Time'; e = { $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') } } |
            Format-Table -AutoSize
        Write-Output ("共 {0} 份，合计 {1:N1} MB" -f $snaps.Count, (($snaps | Measure-Object Length -Sum).Sum / 1MB))
    }

    'Prune' {
        $snaps = @(Get-Snapshots)
        if ($snaps.Count -le $Prune) {
            Write-Output ("只有 {0} 份快照，不删除（保留上限 {1}）" -f $snaps.Count, $Prune)
            return
        }
        $stale = $snaps | Select-Object -Skip $Prune
        foreach ($s in $stale) {
            Remove-Item -LiteralPath $s.FullName -Force
            Write-Output ("已删除 " + $s.Name)
        }
        Write-Output ("保留最近 {0} 份，删除 {1} 份" -f $Prune, $stale.Count)
    }

    default {
        if (-not (Test-Path $snapDir)) {
            New-Item -ItemType Directory -Path $snapDir | Out-Null
        }

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $name  = if ($Note) { "qq-bridge_$stamp`_$Note.zip" } else { "qq-bridge_$stamp.zip" }
        $zip   = Join-Path $snapDir $name
        $sw    = [System.Diagnostics.Stopwatch]::StartNew()

        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem

        $files = Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue
        $added = 0
        $skipped = 0

        $zipStream = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
        try {
            foreach ($f in $files) {
                $rel = $f.FullName.Substring($root.Length).TrimStart('\')
                $parts = $rel.Split('\')

                # 目录排除（任意层级命中即跳过）
                $inExcluded = $false
                foreach ($p in $parts[0..([Math]::Max(0, $parts.Length - 2))]) {
                    if ($excludeDirs -contains $p) { $inExcluded = $true; break }
                }
                if ($inExcluded) { $skipped++; continue }

                # 文件排除
                $skipFile = $false
                foreach ($pat in $excludeFiles) {
                    if ($f.Name -like $pat) { $skipFile = $true; break }
                }
                if ($skipFile) { $skipped++; continue }

                if ($f.Length -gt ($maxFileMB * 1MB)) { $skipped++; continue }

                $entryName = $rel.Replace('\', '/')
                $entry = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zipStream, $f.FullName, $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal)
                $added++
            }
        }
        finally {
            $zipStream.Dispose()
        }

        $sw.Stop()
        $info = Get-Item $zip

        Write-Output ("快照已创建：{0}" -f $zip)
        Write-Output ("  入库 {0} 个文件，跳过 {1} 个；{2:N1} MB；耗时 {3:N1}s" -f
            $added, $skipped, ($info.Length / 1MB), $sw.Elapsed.TotalSeconds)
        Write-Output ("  回滚：Expand-Archive '{0}' -DestinationPath <目标> -Force" -f $zip)
    }
}
