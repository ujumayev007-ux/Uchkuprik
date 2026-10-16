import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import uz.fastfood.app.SeenOrders;
import uz.fastfood.app.SseReader;

/**
 * Plain-JVM probe of the Android alert client logic: it connects to /api/live/alerts
 * exactly like AlertService (same SseReader and SeenOrders classes), prints every
 * event and "NEW <orderId>" the first time an order would be announced. Used by the
 * local scenario tests; it is not part of the APK.
 *
 *   java -cp out StreamProbe <url> <maxMillis> <dropAfterMillis|0>   (cookie in PROBE_COOKIE)
 */
public class StreamProbe {
    static final Pattern ORDER = Pattern.compile("\"orderId\":\"([^\"]+)\"");

    public static void main(String[] args) throws Exception {
        String url = args[0];
        long maxMs = Long.parseLong(args[1]);
        long dropAfter = Long.parseLong(args[2]);
        String cookie = System.getenv("PROBE_COOKIE");
        long end = System.currentTimeMillis() + maxMs;
        SeenOrders seen = new SeenOrders("", 3L * 60 * 60 * 1000);
        AtomicBoolean running = new AtomicBoolean(true);
        boolean dropped = false;
        int connections = 0;
        while (System.currentTimeMillis() < end && running.get()) {
            HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
            http.setConnectTimeout(8000);
            http.setReadTimeout(70000);
            http.setRequestProperty("Accept", "text/event-stream");
            if (cookie != null) http.setRequestProperty("Cookie", cookie);
            int code = http.getResponseCode();
            connections++;
            System.out.println("CONNECT #" + connections + " HTTP " + code);
            System.out.flush();
            if (code != 200) {
                http.disconnect();
                Thread.sleep(500);
                continue;
            }
            long started = System.currentTimeMillis();
            boolean willDrop = dropAfter > 0 && !dropped;
            InputStream stream = http.getInputStream();
            Thread killer = null;
            if (willDrop) {
                dropped = true;
                killer = new Thread(() -> {
                    try {
                        Thread.sleep(dropAfter);
                    } catch (InterruptedException ignored) {
                    }
                    http.disconnect();
                });
                killer.start();
            }
            try {
                SseReader.read(stream, () -> System.currentTimeMillis() < end && running.get(), (event, data) -> {
                    System.out.println("EVENT " + event + " " + data);
                    if (event.equals("walkin") || event.equals("snapshot")) {
                        Matcher m = ORDER.matcher(data);
                        while (m.find())
                            if (seen.markIfNew(m.group(1), System.currentTimeMillis()))
                                System.out.println("NEW " + m.group(1));
                    }
                    if (event.equals("bye")) running.set(false);
                    System.out.flush();
                });
            } catch (Exception error) {
                System.out.println("DROPPED " + error.getClass().getSimpleName());
            } finally {
                http.disconnect();
            }
            if (System.currentTimeMillis() - started < 200) Thread.sleep(300);
        }
        System.out.println("DONE connections=" + connections);
    }
}
