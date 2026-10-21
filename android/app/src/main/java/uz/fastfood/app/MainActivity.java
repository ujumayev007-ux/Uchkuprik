package uz.fastfood.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * FastFood for phones and tablets: connects to the FastFood computer in the
 * restaurant (same Wi-Fi) and runs the app from it. The interface is served by
 * that computer, so updating the computer updates every phone automatically.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "fastfood";
    private static final String KEY_SERVER = "server";
    private static final int FILE_REQUEST = 41;
    private static final int NOTIFY_REQUEST = 42;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    // Page to open once the app is up (a tapped notification: «Stol belgilash»).
    private String pendingPath;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // A TV screen never sleeps.
        if (BuildConfig.IS_TV) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        pendingPath = pathFrom(getIntent());
        String server = prefs().getString(KEY_SERVER, null);
        if (server == null) showSetup(null);
        else showApp(server);
    }

    private static String pathFrom(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra(AlertService.EXTRA_PATH);
        // Only paths of the FastFood app itself are accepted.
        return path != null && path.startsWith("/") && !path.startsWith("//") ? path : null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String path = pathFrom(intent);
        String server = prefs().getString(KEY_SERVER, null);
        if (path != null && server != null) {
            if (web != null) web.loadUrl(server + path);
            else {
                pendingPath = path;
                showApp(server);
            }
        }
    }

    /**
     * Lets the web app (served by the restaurant computer) start the waiter alert
     * service with the central settings. Only pages of that server can be loaded in
     * this WebView, so only the restaurant's own app can call it.
     */
    private class AlertBridge {
        @JavascriptInterface
        public void configureAlerts(String json) {
            try {
                JSONObject settings = new JSONObject(json);
                if (!settings.optBoolean("enabled", false)) {
                    AlertService.stop(MainActivity.this);
                    return;
                }
                getSharedPreferences(AlertService.PREFS, MODE_PRIVATE).edit()
                    .putBoolean("sound", settings.optBoolean("sound", true))
                    .putBoolean("voice", settings.optBoolean("voice", true))
                    .putInt("volume", settings.optInt("volume", 100))
                    .putInt("repeat", settings.optInt("repeat", 1))
                    .putInt("reminder", settings.optInt("reminderSeconds", 0))
                    .apply();
                AlertService.start(MainActivity.this);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void stopAlerts() {
            AlertService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public String alertStatus() {
            try {
                JSONObject status = new JSONObject();
                status.put("running", AlertService.wanted(MainActivity.this));
                status.put("notifications", AlertService.notificationsAllowed(MainActivity.this));
                status.put("ttsReady", true);
                return status.toString();
            } catch (Exception error) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33)
                    requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, NOTIFY_REQUEST);
                else openAlertSettings();
            });
        }

        @JavascriptInterface
        public void openAlertSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                try {
                    startActivity(intent);
                } catch (Exception ignored) {
                }
            });
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == NOTIFY_REQUEST && web != null)
            web.evaluateJavascript("window.dispatchEvent(new Event('ff-android-permission'))", null);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** Accepts "192.168.1.11", "192.168.1.11:8787" or a full http(s) address. */
    private static String normalize(String input) {
        String value = input.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        try {
            URL url = new URL(value);
            int port = url.getPort();
            boolean https = url.getProtocol().equals("https");
            return url.getProtocol() + "://" + url.getHost()
                + (port > 0 ? ":" + port : (https ? "" : ":8787"));
        } catch (Exception e) {
            return null;
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showSetup(String error) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(Color.rgb(247, 246, 242));

        TextView title = new TextView(this);
        title.setText("FAST FOOD");
        title.setTextSize(26);
        title.setTextColor(Color.rgb(233, 83, 36));
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Restoran kompyuteridagi FastFood manzilini kiriting.\n"
            + "Uni kompyuterda: FastFood → Telefonlar uchun manzil.\n"
            + "Telefon shu Wi‑Fi tarmog‘ida bo‘lishi kerak.");
        hint.setTextSize(15);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(12), 0, dp(16));
        box.addView(hint);

        EditText input = new EditText(this);
        input.setHint("192.168.1.11:8787");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        String saved = prefs().getString(KEY_SERVER, "");
        input.setText(saved.replace("http://", ""));
        box.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView status = new TextView(this);
        status.setTextColor(Color.rgb(192, 57, 43));
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(10), 0, dp(10));
        if (error != null) status.setText(error);
        box.addView(status);

        Button connect = new Button(this);
        connect.setText("Ulanish");
        box.addView(connect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        connect.setOnClickListener(v -> {
            String server = normalize(input.getText().toString());
            if (server == null) {
                status.setText("Manzil noto‘g‘ri.");
                return;
            }
            status.setTextColor(Color.DKGRAY);
            status.setText("Tekshirilmoqda…");
            connect.setEnabled(false);
            new Thread(() -> {
                boolean ok = reachable(server);
                runOnUiThread(() -> {
                    connect.setEnabled(true);
                    if (ok) {
                        prefs().edit().putString(KEY_SERVER, server).apply();
                        showApp(server);
                    } else {
                        status.setTextColor(Color.rgb(192, 57, 43));
                        status.setText("Kompyuterga ulanib bo‘lmadi. Manzil va Wi‑Fi’ni tekshiring, FastFood kompyuterda ochiq bo‘lsin.");
                    }
                });
            }).start();
        });
        setContentView(box);
    }

    private static boolean reachable(String server) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(server + "/api/health/live").openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private void showApp(String server) {
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Lets the web app know this shell version (to offer a newer APK).
        try {
            String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            settings.setUserAgentString(settings.getUserAgentString() + " FastFoodAndroid/" + version);
        } catch (Exception ignored) {
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // Pages of the restaurant computer stay inside the app; others open in the browser.
                // APK downloads go to the browser, which installs them.
                if (url.toString().startsWith(server) && !url.toString().endsWith(".apk")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame())
                    showSetup("Kompyuterga ulanib bo‘lmadi. FastFood kompyuterda ochiqligini va Wi‑Fi’ni tekshiring.");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Photo evidence (checklists, incidents): camera or gallery.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new AlertBridge(), "FastFoodAndroid");
        // The waiter app opens the waiter screen, the TV app the customer queue screen.
        web.loadUrl(server + (pendingPath != null ? pendingPath : BuildConfig.START_PATH));
        pendingPath = null;
        setContentView(web);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else if (web != null) showSetup(null);
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

}
