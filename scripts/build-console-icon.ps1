# build-console-icon.ps1 —— 把一张方形 PNG 生成 Windows 多尺寸 .ico（切圆角 + 透明角）
#
# 源图：assets\console-icon.png（青绿渐变底 + 白色气泡里的终端提示符 >_，1024×1024）
# 重跑：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-console-icon.ps1
#
# 踩过的三个坑（血泪，别再踩）：
#   1) 生成图 24bpp 无 alpha，圆角外是白底 —— 不切，桌面/任务栏露白角；
#   2) 资源管理器按 16/24/32/48px 取 ICO 内对应尺寸，只塞 256 会糊 —— 每个尺寸都要重采样；
#   3) **小于 256px 的帧要用 32bpp DIB，而且 AND 掩码必须按 alpha 阈值写**（alpha<128 → 置 1）。
#      掩码全零时 Shell 会整个拒绝这个 ICO、回落到「未知文件」白纸图标，而 .NET 的 Icon 类
#      照样能解析 —— 于是代码看着全对、桌面是白纸。256px 帧用 PNG 即可（Vista+ 支持）。
#
# 验证口诀：别看 ICO 能不能被 .NET 打开，要用 IShellItemImageFactory 取快捷方式的真实渲染结果：
#   $bmp = [ShellThumb]::Get($lnkPath, 256, $true)   # 返回白纸 = 图标被 Shell 拒了
#
#   4) **生成的 ICO 必须安装到 default-workspace 之外再用！**（2026-10-19 实测）
#      default-workspace 目录带一条显式 Deny ACL（Everyone: DeleteSubdirectoriesAndFiles，
#      非继承），Shell 对放在该目录树下的任何 .ico 一律拒绝渲染（连系统 OneDrive.ico 拷进去
#      也是白纸），而同字节文件放 %LOCALAPPDATA%\QQConsole\ 正常。因为要跟着仓库走，
#      源 .ico 仍生成在 assets\，但 -Install 会再复制一份到 %LOCALAPPDATA%\QQConsole\ 并
#      把桌面/开始菜单快捷方式指过去 —— 快捷方式永远别指向 assets\ 里的 .ico。
#
# 换图：覆盖 assets\console-icon.png 后重跑（输出换新文件名绕开图标缓存）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-console-icon.ps1 -Install
# 再跑 ie4uinit.exe -show 或重建 iconcache 刷新。

param(
  [string]$Source = (Join-Path $PSScriptRoot '..\assets\console-icon.png'),
  [string]$Output = (Join-Path $PSScriptRoot '..\assets\console-v9.ico'),
  [float]$RadiusFactor = 0.215,
  # 复制到 %LOCALAPPDATA%\QQConsole\ 并重绑桌面/开始菜单快捷方式（必须，见上面坑 4）
  [switch]$Install,
  [string]$ShortcutName = 'QQ 控制台'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $Source)) { throw "找不到源图：$Source" }

if (-not ('IcoBuilder' -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class IcoBuilder
{
    static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2;
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // 缩放到目标尺寸 + 抗锯齿圆角：圆角外 alpha 置 0
    static Bitmap RoundedScaled(Image src, int size, float radiusFactor)
    {
        var dst = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(dst))
        {
            g.Clear(Color.Transparent);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, size, size),
                new Rectangle(0, 0, src.Width, src.Height), GraphicsUnit.Pixel);
        }

        using (var mask = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var mg = Graphics.FromImage(mask))
            {
                mg.Clear(Color.Transparent);
                mg.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = RoundedRect(new RectangleF(0, 0, size, size), size * radiusFactor))
                using (var brush = new SolidBrush(Color.Black))
                    mg.FillPath(brush, path);
            }

            var rect = new Rectangle(0, 0, size, size);
            var d = dst.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            var m = mask.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            byte[] px = new byte[d.Stride * size];
            byte[] mk = new byte[m.Stride * size];
            Marshal.Copy(d.Scan0, px, 0, px.Length);
            Marshal.Copy(m.Scan0, mk, 0, mk.Length);
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    int a = mk[y * m.Stride + x * 4 + 3];
                    px[y * d.Stride + x * 4 + 3] = (byte)(px[y * d.Stride + x * 4 + 3] * a / 255);
                }
            Marshal.Copy(px, 0, d.Scan0, px.Length);
            dst.UnlockBits(d);
            mask.UnlockBits(m);
        }
        return dst;
    }

    // 32bpp DIB 帧：BITMAPINFOHEADER + 自下而上 BGRA + AND 掩码（alpha<128 置 1）
    static byte[] ToDib(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var rect = new Rectangle(0, 0, w, h);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        byte[] pixels = new byte[stride * h];
        Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        bmp.UnlockBits(data);

        int maskStride = ((w + 31) / 32) * 4;
        int maskSize = maskStride * h;
        int xorSize = w * h * 4;
        byte[] result = new byte[40 + xorSize + maskSize];

        using (var ms = new MemoryStream(result))
        using (var bw = new BinaryWriter(ms))
        {
            bw.Write(40);              // biSize
            bw.Write(w);               // biWidth
            bw.Write(h * 2);           // biHeight（XOR + AND）
            bw.Write((short)1);        // biPlanes
            bw.Write((short)32);       // biBitCount
            bw.Write(0);               // biCompression = BI_RGB
            bw.Write(xorSize);         // biSizeImage
            bw.Write(0); bw.Write(0);  // 分辨率
            bw.Write(0); bw.Write(0);  // 调色板
            for (int y = h - 1; y >= 0; y--)
                bw.Write(pixels, y * stride, w * 4);

            byte[] mask = new byte[maskSize];
            for (int y = 0; y < h; y++)
            {
                int srcRow = y * stride;
                int dstRow = (h - 1 - y) * maskStride;
                for (int x = 0; x < w; x++)
                    if (pixels[srcRow + x * 4 + 3] < 128)
                        mask[dstRow + (x / 8)] |= (byte)(0x80 >> (x % 8));
            }
            bw.Write(mask);
        }
        return result;
    }

    static byte[] ToPng(Bitmap bmp)
    {
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    public static void Build(string srcPath, string outPath, int[] sizes, float radiusFactor)
    {
        using (var src = Image.FromFile(srcPath))
        {
            var frames = new List<byte[]>();
            foreach (var s in sizes)
            {
                using (var bmp = RoundedScaled(src, s, radiusFactor))
                    frames.Add(s >= 256 ? ToPng(bmp) : ToDib(bmp));
            }
            using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
            using (var w = new BinaryWriter(fs))
            {
                w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)sizes.Length);
                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)
                {
                    int s = sizes[i];
                    w.Write((byte)(s >= 256 ? 0 : s));
                    w.Write((byte)(s >= 256 ? 0 : s));
                    w.Write((byte)0); w.Write((byte)0);
                    w.Write((ushort)1); w.Write((ushort)32);
                    w.Write((uint)frames[i].Length);
                    w.Write((uint)offset);
                    offset += frames[i].Length;
                }
                foreach (var f in frames) w.Write(f);
            }
        }
    }
}
'@
}

[IcoBuilder]::Build($Source, $Output, [int[]](16, 24, 32, 48, 64, 128, 256), $RadiusFactor)
Write-Host ("已生成 {0}（{1} 字节，7 个尺寸；16-128 为 32bpp DIB + AND 掩码，256 为 PNG）" -f $Output, (Get-Item $Output).Length)

if (-not $Install) {
  Write-Host '提示：只生成没安装。快捷方式不能用 assets\ 里的 ICO（见文件头坑 4），要加 -Install。'
  return
}

# 安装到工作区外（Shell 只认这里的），再把快捷方式指过去
$installDir = Join-Path $env:LOCALAPPDATA 'QQConsole'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$installed = Join-Path $installDir (Split-Path $Output -Leaf)
Copy-Item $Output $installed -Force
Write-Host ("已安装 {0}（{1} 字节）" -f $installed, (Get-Item $installed).Length)

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) ("$ShortcutName.lnk")),
  (Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') ("$ShortcutName.lnk"))
)
$wsh = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
  if (-not (Test-Path $lnk)) { Write-Warning ("快捷方式不存在，跳过：{0}" -f $lnk); continue }
  $sc = $wsh.CreateShortcut($lnk)
  $sc.IconLocation = "$installed,0"
  $sc.Save()
  Write-Host ("  快捷方式已重绑：{0} -> {1}" -f $lnk, $sc.IconLocation)
}
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($wsh) | Out-Null

# 清图标缓存（不重启 explorer 时用 ie4uinit；这里两招都上）
$explorerCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
Get-ChildItem $explorerCache -Filter 'iconcache*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path "$env:WINDIR\System32\ie4uinit.exe") { & "$env:WINDIR\System32\ie4uinit.exe" -show 2>$null }
Write-Host '图标缓存已清理。若资源管理器仍显示旧图标：taskkill /f /im explorer.exe && start explorer.exe'
Write-Host '验证：用 IShellItemImageFactory 取快捷方式 256px 渲染结果，得到白纸即为失败（见文件头）。'
