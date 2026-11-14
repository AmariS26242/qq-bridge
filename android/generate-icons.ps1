# generate-icons.ps1 —— 从一张 1024 源图生成 Android 各密度启动图标（圆角透明）
param(
  [string]$Source = (Join-Path $PSScriptRoot "../assets/console-icon.png")
)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$resRoot = Join-Path $PSScriptRoot 'app\res'
$map = @{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }

$src = [System.Drawing.Bitmap]::FromFile($Source)

function New-RoundedIcon([System.Drawing.Bitmap]$src, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = [Math]::Max(2, [int]($size * 0.22))
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.SetClip($path)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.ResetClip()
  $g.Dispose()
  $path.Dispose()
  return $bmp
}

foreach ($k in $map.Keys) {
  $dir = Join-Path $resRoot $k
  New-Item -ItemType Directory -Force $dir | Out-Null
  $out = Join-Path $dir 'ic_launcher.png'
  $bmp = New-RoundedIcon $src $map[$k]
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "  $k -> {0}x{0}  {1} B" -f $map[$k], (Get-Item $out).Length
}
$src.Dispose()
