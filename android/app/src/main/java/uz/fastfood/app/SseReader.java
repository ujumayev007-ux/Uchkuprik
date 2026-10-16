package uz.fastfood.app;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/**
 * Minimal Server-Sent Events reader (no Android classes, so it is also exercised by a
 * plain JVM probe in android/test). Comment lines (": ping") and unknown fields are
 * ignored; an event is delivered when its terminating blank line arrives.
 */
public final class SseReader {
    public interface Handler {
        void onEvent(String event, String data);
    }

    private SseReader() {}

    /** Blocks until the stream ends, the connection fails or `running` turns false. */
    public static void read(InputStream stream, BooleanSupplier running, Handler handler) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String event = null;
            StringBuilder data = new StringBuilder();
            String line;
            while (running.getAsBoolean() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event != null && data.length() > 0) handler.onEvent(event, data.toString());
                    event = null;
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).trim());
                }
            }
        }
    }
}
