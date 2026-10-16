package uz.fastfood.app;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Remembers which orders were already announced, so a reconnect (the server resends
 * the waiting guests on every connect) or a restart never repeats an announcement.
 * Pure Java: the text form is stored in SharedPreferences by the service.
 */
public final class SeenOrders {
    private final long ttlMs;
    private final Map<String, Long> seen = new LinkedHashMap<>();

    public SeenOrders(String stored, long ttlMs) {
        this.ttlMs = ttlMs;
        if (stored == null || stored.isEmpty()) return;
        for (String part : stored.split(";")) {
            int at = part.lastIndexOf('=');
            if (at <= 0) continue;
            try {
                seen.put(part.substring(0, at), Long.parseLong(part.substring(at + 1)));
            } catch (NumberFormatException ignored) {
            }
        }
    }

    /** True the first time an order id is seen (within the retention window). */
    public synchronized boolean markIfNew(String orderId, long now) {
        Iterator<Map.Entry<String, Long>> it = seen.entrySet().iterator();
        while (it.hasNext()) if (now - it.next().getValue() > ttlMs) it.remove();
        if (seen.containsKey(orderId)) return false;
        seen.put(orderId, now);
        return true;
    }

    public synchronized String serialize() {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, Long> entry : seen.entrySet()) {
            if (out.length() > 0) out.append(';');
            out.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return out.toString();
    }
}
