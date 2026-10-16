package uz.fastfood.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Locale;
import java.util.Set;

/**
 * Keeps one live connection to the FastFood server for waiter tablets and announces,
 * in Uzbek and with a notification, every guest that ordered at the cashier and
 * still needs a table. Runs as a foreground service, so it keeps working with the
 * screen off.
 *
 * Settings (sound, voice, volume, repeat, reminder) come from the Owner's central
 * policy: the web app hands them over, and the server resends them on every connect
 * and whenever the policy changes. Each order is announced once: the ids already
 * announced are stored, so reconnects and restarts never repeat an announcement.
 */
public class AlertService extends Service {
    private static final String TAG = "FastFoodAlerts";
    static final String PREFS = "fastfood_alerts";
    static final String CHANNEL = "walkin_alerts";
    static final String CHANNEL_SERVICE = "alerts_service";
    static final String EXTRA_PATH = "path";
    private static final int SERVICE_NOTIFICATION = 7001;
    private static final long SEEN_TTL_MS = 3L * 60 * 60 * 1000;
    private static final String PHRASE = "Yangi mijoz buyurtmasi. Stolni belgilang.";

    private volatile boolean running;
    private volatile Thread worker;
    private Handler main;
    private TextToSpeech tts;
    private boolean ttsReady;
    private PowerManager.WakeLock wakeLock;
    // Orders still waiting for a table (for reminders): id -> number.
    private final Map<String, Integer> waiting = new LinkedHashMap<>();
    private int reminders;
    private HttpURLConnection connection;

    /** True while the service has been asked to run (also after a reboot). */
    static boolean wanted(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false);
    }

    static void start(Context context) {
        Intent intent = new Intent(context, AlertService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    static void stop(Context context) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        context.stopService(new Intent(context, AlertService.class));
    }

    static boolean notificationsAllowed(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
        if (manager != null && !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 33)
            return context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        return true;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        main = new Handler(Looper.getMainLooper());
        createChannels();
        tts = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                Log.w(TAG, "Text-to-speech engine is not available");
                return;
            }
            // Uzbek first; Turkish reads Uzbek Latin text acceptably when the device has no Uzbek voice.
            int result = tts.setLanguage(new Locale("uz", "UZ"));
            if (result < TextToSpeech.LANG_AVAILABLE) result = tts.setLanguage(new Locale("uz"));
            if (result < TextToSpeech.LANG_AVAILABLE) result = tts.setLanguage(new Locale("tr", "TR"));
            ttsReady = true;
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        prefs().edit().putBoolean("enabled", true).apply();
        Notification notification = serviceNotification();
        if (Build.VERSION.SDK_INT >= 34)
            startForeground(SERVICE_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(SERVICE_NOTIFICATION, notification);
        if (!running) {
            running = true;
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fastfood:alerts");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
            worker = new Thread(this::loop, "fastfood-alerts");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
        if (worker != null) worker.interrupt();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel service = new NotificationChannel(
            CHANNEL_SERVICE, "Ulanish holati", NotificationManager.IMPORTANCE_MIN);
        service.setShowBadge(false);
        manager.createNotificationChannel(service);
        NotificationChannel alert = new NotificationChannel(
            CHANNEL, "Yangi mijoz buyurtmalari", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("Stol belgilanmagan mijoz buyurtmasi haqida ogohlantirish");
        alert.enableVibration(true);
        manager.createNotificationChannel(alert);
    }

    private PendingIntent openApp(String path, int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (path != null) intent.putExtra(EXTRA_PATH, path);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private Notification serviceNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_SERVICE)
            : new Notification.Builder(this);
        return builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("FastFood: mijoz xabarlari yoqilgan")
            .setContentText("Yangi mijoz buyurtmasi haqida ovozli ogohlantirish beriladi.")
            .setOngoing(true)
            .setContentIntent(openApp(null, 1))
            .build();
    }

    // ---- connection --------------------------------------------------------------

    private void loop() {
        long backoff = 2000;
        while (running) {
            try {
                if (!connectOnce()) {
                    // Signed out or the feature was switched off: stop quietly. The web
                    // app starts the service again after the next sign-in.
                    running = false;
                    prefs().edit().putBoolean("enabled", false).apply();
                    main.post(() -> {
                        stopForeground(true);
                        stopSelf();
                    });
                    break;
                }
                backoff = 2000;
            } catch (Exception error) {
                if (!running) break;
                Log.d(TAG, "Alert stream interrupted: " + error.getMessage());
            }
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException interrupted) {
                break;
            }
            backoff = Math.min(backoff * 2, 30000);
        }
    }

    /** Returns false when the server refused the stream (not signed in / switched off). */
    private boolean connectOnce() throws Exception {
        String server = getSharedPreferences("fastfood", MODE_PRIVATE).getString("server", null);
        if (server == null) return false;
        URL url = new URL(server + "/api/live/alerts");
        HttpURLConnection http = (HttpURLConnection) url.openConnection();
        connection = http;
        http.setConnectTimeout(8000);
        // The server sends a heartbeat every 20 seconds.
        http.setReadTimeout(70000);
        http.setRequestProperty("Accept", "text/event-stream");
        String cookie = CookieManager.getInstance().getCookie(server);
        if (cookie != null) http.setRequestProperty("Cookie", cookie);
        int code = http.getResponseCode();
        if (code == 401 || code == 403) {
            http.disconnect();
            return false;
        }
        if (code != 200) {
            http.disconnect();
            throw new Exception("HTTP " + code);
        }
        try {
            SseReader.read(http.getInputStream(), () -> running, this::handle);
        } finally {
            http.disconnect();
        }
        return true;
    }

    private void handle(String event, String payload) {
        try {
            JSONObject json = new JSONObject(payload);
            switch (event) {
                case "config":
                    prefs().edit()
                        .putBoolean("sound", json.optBoolean("sound", true))
                        .putBoolean("voice", json.optBoolean("voice", true))
                        .putInt("volume", json.optInt("volume", 100))
                        .putInt("repeat", json.optInt("repeat", 1))
                        .putInt("reminder", json.optInt("reminderSeconds", 0))
                        .apply();
                    main.post(this::scheduleReminder);
                    break;
                case "snapshot": {
                    JSONArray orders = json.optJSONArray("orders");
                    Set<String> open = new LinkedHashSet<>();
                    if (orders != null)
                        for (int i = 0; i < orders.length(); i++) {
                            JSONObject order = orders.getJSONObject(i);
                            open.add(order.getString("orderId"));
                            announce(order.getString("orderId"), order.optInt("number", 0));
                        }
                    synchronized (waiting) {
                        waiting.keySet().retainAll(open);
                    }
                    break;
                }
                case "walkin":
                    announce(json.getString("orderId"), json.optInt("number", 0));
                    break;
                case "assigned":
                    resolve(json.getString("orderId"));
                    break;
                case "bye":
                    // Session ended or the feature was switched off by the Owner/Admin.
                    running = false;
                    main.post(() -> {
                        stopForeground(true);
                        stopSelf();
                    });
                    break;
                default:
                    break;
            }
        } catch (JSONException error) {
            Log.w(TAG, "Bad event: " + error.getMessage());
        }
    }

    // ---- announcing --------------------------------------------------------------

    /** Each order id is announced once, across reconnects and restarts. */
    private synchronized boolean firstTime(String orderId) {
        SeenOrders seen = new SeenOrders(prefs().getString("seen2", ""), SEEN_TTL_MS);
        boolean fresh = seen.markIfNew(orderId, System.currentTimeMillis());
        if (fresh) prefs().edit().putString("seen2", seen.serialize()).apply();
        return fresh;
    }

    private static String formatNumber(int number) {
        return String.format(Locale.US, "№%03d", number);
    }

    private void announce(String orderId, int number) {
        synchronized (waiting) {
            waiting.put(orderId, number);
        }
        if (!firstTime(orderId)) return;
        main.post(() -> {
            reminders = 0;
            ring(orderId, number, false);
            scheduleReminder();
        });
    }

    private void ring(String orderId, int number, boolean reminder) {
        boolean sound = prefs().getBoolean("sound", true);
        boolean voice = prefs().getBoolean("voice", true);
        int volume = Math.max(10, Math.min(100, prefs().getInt("volume", 100)));
        int repeat = Math.max(1, Math.min(5, prefs().getInt("repeat", 1)));
        if (!notificationsAllowed(this)) Log.d(TAG, "Notifications are not allowed; voice only");
        else showNotification(orderId, number);
        if (sound) {
            try {
                ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, volume);
                tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 500);
                main.postDelayed(tone::release, 900);
            } catch (RuntimeException error) {
                Log.d(TAG, "Tone failed: " + error.getMessage());
            }
        }
        vibrate();
        if (voice && ttsReady && tts != null) {
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume / 100f);
            int times = reminder ? 1 : repeat;
            for (int i = 0; i < times; i++)
                tts.speak(PHRASE, i == 0 && !reminder ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
                    params, "walkin-" + orderId + "-" + i + "-" + System.nanoTime());
        }
    }

    private void showNotification(String orderId, int number) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        String path = "/ofitsiant?stol-belgilash=" + orderId;
        int id = orderId.hashCode();
        PendingIntent open = openApp(path, id);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH);
        Notification.Action action = new Notification.Action.Builder(
            null, "Stol belgilash", open).build();
        builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Yangi mijoz buyurtmasi")
            .setContentText(formatNumber(number) + " buyurtma uchun stolni belgilang")
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(action);
        manager.notify(id, builder.build());
    }

    private void vibrate() {
        try {
            Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26)
                vibrator.vibrate(VibrationEffect.createWaveform(new long[] {0, 300, 150, 300}, -1));
            else vibrator.vibrate(new long[] {0, 300, 150, 300}, -1);
        } catch (RuntimeException ignored) {
        }
    }

    /** A table was chosen (or the order closed): drop the notification and reminders. */
    private void resolve(String orderId) {
        synchronized (waiting) {
            waiting.remove(orderId);
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(orderId.hashCode());
    }

    private final Runnable reminderTick = new Runnable() {
        @Override
        public void run() {
            int seconds = prefs().getInt("reminder", 0);
            String first = null;
            int number = 0;
            synchronized (waiting) {
                if (!waiting.isEmpty()) {
                    Map.Entry<String, Integer> entry = waiting.entrySet().iterator().next();
                    first = entry.getKey();
                    number = entry.getValue();
                }
            }
            if (seconds <= 0 || first == null || reminders >= 5) return;
            reminders += 1;
            // Voice and notification again for the oldest guest still waiting.
            ring(first, number, true);
            main.postDelayed(this, seconds * 1000L);
        }
    };

    private void scheduleReminder() {
        main.removeCallbacks(reminderTick);
        int seconds = prefs().getInt("reminder", 0);
        boolean any;
        synchronized (waiting) {
            any = !waiting.isEmpty();
        }
        if (seconds > 0 && any) main.postDelayed(reminderTick, seconds * 1000L);
    }
}
