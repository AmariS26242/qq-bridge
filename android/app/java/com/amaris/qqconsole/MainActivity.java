package com.amaris.qqconsole;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 一个尽量薄的 WebView 外壳：默认打开 QQ 手机看板，地址和配对都可改。
 *
 * 设计取舍：
 * - 不引 AndroidX / 任何依赖，纯 framework API，这样可以用 aapt2 + javac + d8 手工打包，
 *   不必为了一个壳子把 Gradle 全家桶拖进来。
 * - DOM storage 必须开：看板把 console token 存在 localStorage。
 * - 第三方 cookie 接受：配对 cookie 是桥下发的 HttpOnly cookie，WebView 自己的 CookieManager
 *   要能收；同源页面才能读，安全边界仍在服务端。
 * - 非 http(s) 的链接（mailto/tel/其他 app）交给系统，别在 WebView 里 404。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "qq_console";
    private static final String KEY_URL = "url";
    private static final String DEFAULT_URL = "https://console.example.com:8443/qq/m";

    private WebView web;
    private ProgressBar bar;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        setTitle(R.string.app_name);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d1418"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " QQConsole/1.0");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (android.os.Build.VERSION.SDK_INT >= 21) cm.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternal(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 配对链接会 303 到 /qq/m。把落地页记下来，下次启动直接进看板而不是再跳一次。
                if (url == null) return;
                if (url.contains("/qq/m") || url.contains("/__qq/m")) {
                    if (!url.equals(prefs.getString(KEY_URL, ""))) {
                        prefs.edit().putString(KEY_URL, url).apply();
                    }
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (bar == null) return;
                bar.setProgress(progress);
                bar.setVisibility(progress >= 100 ? ViewGroup.GONE : ViewGroup.VISIBLE);
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 6);
        root.addView(bar, lp);

        setContentView(root);
        web.loadUrl(prefs.getString(KEY_URL, DEFAULT_URL));
    }

    /** 非 http(s) 交给系统处理；返回 true 表示这次导航被我们接管了。 */
    private boolean openExternal(String url) {
        if (url == null) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // 没有能处理它的 app，就当没点
        }
        return true;
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, R.string.menu_address);
        menu.add(0, 2, 1, R.string.menu_pair);
        menu.add(0, 3, 2, R.string.menu_reload);
        menu.add(0, 4, 3, R.string.menu_about);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case 1: editAddress(); return true;
            case 2: pairWithLink(); return true;
            case 3: web.reload(); return true;
            case 4:
                new AlertDialog.Builder(this)
                        .setTitle(R.string.app_name)
                        .setMessage(R.string.about_text)
                        .setPositiveButton(R.string.cancel, null)
                        .show();
                return true;
            default: return super.onOptionsItemSelected(item);
        }
    }

    private void editAddress() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefs.getString(KEY_URL, DEFAULT_URL));
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle(R.string.address_title)
                .setView(input)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) return;
                    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
                    prefs.edit().putString(KEY_URL, url).apply();
                    web.loadUrl(url);
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void pairWithLink() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.pair_hint);
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle(R.string.pair_title)
                .setView(input)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) return;
                    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
                    // 配对链接会 303 到看板；把跳转后的地址留下来，下次直接打开看板
                    web.loadUrl(url);
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
