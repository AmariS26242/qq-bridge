# build-apk.ps1 —— 不依赖 Gradle 的最小 APK 打包流水线
#
# aapt2 compile/link -> javac -> d8 -> jar(塞 classes.dex) -> zipalign -> apksigner
# 这套流程的好处是只要 JDK + Android build-tools，不用拉 Gradle/AGP/Maven。
param(
  [string]$OutName = 'qq-console.apk',
  [string]$VersionName = '1.0',
  [int]$VersionCode = 1
)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
# 工具链（jdk / sdk）可以放在项目里，也可以放在别处用 QQANDROID_HOME 指过来；
# 默认回落 %LOCALAPPDATA%\AndroidBuild（历史上装在这）。
$toolchain = $root
if ($env:QQANDROID_HOME) { $toolchain = $env:QQANDROID_HOME }
elseif (-not (Test-Path (Join-Path $root 'jdk'))) { $toolchain = Join-Path $env:LOCALAPPDATA 'AndroidBuild' }
$sdk = Join-Path $toolchain 'sdk'
$jdkHome = Join-Path $toolchain 'jdk'
$javaHome = (Get-ChildItem $jdkHome -Directory | Select-Object -First 1).FullName
# d8.bat / apksigner.bat 都靠 JAVA_HOME 找 java，脚本自包含地设上
$env:JAVA_HOME = $javaHome
$env:PATH = (Join-Path $javaHome 'bin') + ';' + $env:PATH

$bt = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
foreach ($p in @($bt, $androidJar, $javaHome)) {
  if (-not (Test-Path $p)) { throw "缺少构建依赖: $p" }
}

$java = Join-Path $javaHome 'bin\java.exe'
$javac = Join-Path $javaHome 'bin\javac.exe'
$keytool = Join-Path $javaHome 'bin\keytool.exe'
$jar = Join-Path $javaHome 'bin\jar.exe'
$aapt2 = Join-Path $bt 'aapt2.exe'
$zipalign = Join-Path $bt 'zipalign.exe'
$apksigner = Join-Path $bt 'apksigner.bat'
$d8 = Join-Path $bt 'd8.bat'

$app = Join-Path $root 'app'
$work = Join-Path $root 'build'
$outDir = Join-Path $root 'out'
New-Item -ItemType Directory -Force $work, $outDir | Out-Null

# 0. 清掉上一轮的中间产物（保留 keystore）
foreach ($d in @('res', 'classes', 'dex', 'gen')) {
  $p = Join-Path $work $d
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
$unsigned = Join-Path $work 'app-unsigned.apk'
$aligned = Join-Path $work 'app-aligned.apk'
foreach ($f in @($unsigned, $aligned)) { if (Test-Path $f) { Remove-Item $f -Force } }

# 1. 资源编译
$resZip = Join-Path $work 'res.zip'
& $aapt2 compile --dir (Join-Path $app 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

# 2. 资源链接（生成 R.java + 未签名 APK 壳）
$genDir = Join-Path $work 'gen'
New-Item -ItemType Directory -Force $genDir | Out-Null
& $aapt2 link -o $unsigned -I $androidJar --manifest (Join-Path $app 'AndroidManifest.xml') `
  -R $resZip --java $genDir --min-sdk-version 24 --target-sdk-version 34 `
  --version-code $VersionCode --version-name $VersionName --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

# 3. 编译 Java（release 8 字节码，d8 才能吃）
$srcFiles = @()
$srcFiles += (Get-ChildItem (Join-Path $app 'java') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$srcFiles += (Get-ChildItem $genDir -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$classesDir = Join-Path $work 'classes'
New-Item -ItemType Directory -Force $classesDir | Out-Null
& $javac --release 8 -encoding UTF-8 -classpath $androidJar -d $classesDir $srcFiles
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

# 4. dex
$dexDir = Join-Path $work 'dex'
New-Item -ItemType Directory -Force $dexDir | Out-Null
$classFiles = (Get-ChildItem $classesDir -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $d8 --release --min-api 24 --lib $androidJar --output $dexDir $classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

# 5. classes.dex 塞进 APK
Push-Location $dexDir
& $jar uf $unsigned classes.dex
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'jar uf 失败' }
Pop-Location

# 6. 对齐 + 签名
& $zipalign -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

$ks = Join-Path $root 'console.keystore'
if (-not (Test-Path $ks)) {
  # 走 cmd 并把 stderr 接到文件：PowerShell 5.1 会把 native stderr 当错误记录，配合 Stop 直接中断
  $keyLog = Join-Path $work 'keytool.log'
  $cmd = "`"$keytool`" -genkeypair -keystore `"$ks`" -alias console -keyalg RSA -keysize 2048 " +
         "-validity 10000 -storepass qqconsole -keypass qqconsole " +
         "-dname `"CN=QQ Console, O=Local, C=CN`" > `"$keyLog`" 2>&1"
  & cmd /c $cmd | Out-Null
  if (-not (Test-Path $ks)) { throw ("keystore 生成失败: " + (Get-Content $keyLog -Raw -ErrorAction SilentlyContinue)) }
}

$out = Join-Path $outDir $OutName
$signLog = Join-Path $work 'apksigner.log'
$signCmd = "`"$apksigner`" sign --ks `"$ks`" --ks-pass pass:qqconsole --key-pass pass:qqconsole --out `"$out`" `"$aligned`" > `"$signLog`" 2>&1"
& cmd /c $signCmd | Out-Null
if (-not (Test-Path $out)) { throw ("apksigner sign 失败: " + (Get-Content $signLog -Raw -ErrorAction SilentlyContinue)) }

"  生成: $out  {0:N0} KB" -f ((Get-Item $out).Length / 1KB)
