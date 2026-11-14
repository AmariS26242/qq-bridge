# QQ 后台 Android App（WebView 壳）

把手机看板 `/qq/m` 包成可安装的 APK。壳子只做四件事：加载默认地址、允许改地址、
走一遍配对链接、处理返回键——所有业务逻辑仍在 qq-bridge，改页面不用重新发版。

- 包名 `com.amaris.qqconsole`，label「QQ 后台」，minSdk 24 / targetSdk 34
- 默认地址 `https://console.example.com:8443/qq/m`（走手机桥 HTTPS）
- 菜单（右上角三点）：改地址 / 配对链接 / 刷新 / 关于
- 安装包产物：`dist/qq-console.apk`

## 为什么不用 Gradle

一个 WebView 壳不值得拖 Gradle + AGP + Maven 全家桶。这里用 Android build-tools 原生的
五步流水线，全部由 `build-apk.ps1` 驱动：

```
aapt2 compile → aapt2 link → javac → d8 → jar(塞 classes.dex) → zipalign → apksigner
```

## 一次性装工具链

只需要 JDK 17 和 Android SDK 的 `platforms;android-34` + `build-tools;34.0.0`。
本机默认放在 `%LOCALAPPDATA%\AndroidBuild`：

```
jdk/            msopenjdk-17（解压后目录名 jdk-17.x）
sdk/
  cmdline-tools/latest/
  platforms/android-34/android.jar
  build-tools/34.0.0/{aapt2,zipalign,apksigner,d8}
```

换位置也行，构建前设 `QQANDROID_HOME` 指向那个目录；脚本找不到项目内的 `jdk/`
就回落 `%LOCALAPPDATA%\AndroidBuild`。

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android\build-apk.ps1
```

产物在 `android\out\qq-console.apk`。脚本首次运行会生成自签名 keystore
`android\console.keystore`（口令 `qqconsole`，仅本机自用，别拿去发布）。

改图标：

```powershell
# 源图：qq-bridge\assets\console-icon.png（1024 方形）
powershell -NoProfile -ExecutionPolicy Bypass -File android\generate-icons.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File android\build-apk.ps1
```

## 发版注意

- **版本号在 `app/AndroidManifest.xml` 里改**（`versionCode` 必须递增，否则覆盖安装会失败）；
  命令行 `-VersionCode` 参数实测被 aapt2 忽略，别依赖它。
- 覆盖安装要求签名一致——换机器构建时把 `console.keystore` 一起带上。
- 校验：

```powershell
sdk\build-tools\34.0.0\aapt2.exe dump badging out\qq-console.apk   # 包名/版本/权限/图标
$env:JAVA_HOME='...\jdk\jdk-17.x'; sdk\build-tools\34.0.0\apksigner.bat verify --print-certs out\qq-console.apk
```

## 手机上怎么用

1. 装 APK（需允许「安装未知来源应用」）。
2. 直接打开：进 `/qq/m` 看板；如果被拦到配对页，就把手机桥给的配对链接粘进来
   （菜单 → 配对链接），跳转后地址会自动记住。
3. 只有手机和电脑在同一个 Tailscale 网络里才能访问默认地址；换了入口（比如局域网 IP）
   就在「改地址」里填新的 `/qq/m`。

## 已知限制

- 纯壳：页面白屏时先查桥（`/qq/m` 直连是否 200），不是 App 的问题。
- 不缓存页面，断网就是系统错误页。
- 不支持深色/浅色切换以外的定制；看板本身是深色。
