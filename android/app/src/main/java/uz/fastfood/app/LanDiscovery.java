package uz.fastfood.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Finds the restaurant's FastFood computer on this Wi-Fi, the same way the desktop
 * applications do (desktop/lan.cjs): a UDP question with a fresh nonce, answered with
 * the server's id, name and port signed by its Ed25519 key; when the network drops UDP
 * broadcasts, the own /24 network is asked over HTTP instead. Only private addresses are
 * accepted, and a paired application accepts only its own server's key.
 * Plain Java (no Android classes), so it is also checked on the computer.
 */
public final class LanDiscovery {
    public static final int DISCOVERY_PORT = 47870;
    private static final String MAGIC = "FFLAN1";

    public static final class Server {
        public final String id, key, name, host, ver;
        public final int port;

        Server(String id, String key, String name, int port, String ver, String host) {
            this.id = id;
            this.key = key;
            this.name = name;
            this.port = port;
            this.ver = ver;
            this.host = host;
        }

        public String url() {
            return "http://" + host + ":" + port;
        }

        /** "4F2A-91C7-0B3D": what a person compares with the server screen. */
        public String fingerprint() {
            return id.substring(0, 4) + "-" + id.substring(4, 8) + "-" + id.substring(8, 12);
        }
    }

    private LanDiscovery() {
    }

    /** Servers answering on this network (`pinnedKey` null = every FastFood server). */
    public static List<Server> discover(int port, String pinnedKey, int timeoutMs) {
        String nonce = newNonce();
        Map<String, Server> found = Collections.synchronizedMap(new LinkedHashMap<>());
        try {
            udpScan(port, nonce, pinnedKey, timeoutMs, found);
        } catch (Exception ignored) {
        }
        if (found.isEmpty()) httpSweep(port, nonce, pinnedKey, found);
        return new ArrayList<>(found.values());
    }

    // ------------------------------------------------------------------ network

    private static void udpScan(int port, String nonce, String pinnedKey, int timeoutMs, Map<String, Server> found) throws Exception {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            byte[] body = ("{\"t\":\"" + MAGIC + "\",\"nonce\":\"" + nonce + "\"}").getBytes(StandardCharsets.UTF_8);
            List<InetAddress> targets = new ArrayList<>();
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (InterfaceAddress address : privateInterfaces())
                if (address.getBroadcast() != null) targets.add(address.getBroadcast());
            for (InetAddress target : targets) {
                try {
                    socket.send(new DatagramPacket(body, body.length, target, port));
                } catch (Exception ignored) {
                }
            }
            long end = System.currentTimeMillis() + timeoutMs;
            byte[] buffer = new byte[4096];
            while (true) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                socket.setSoTimeout((int) left);
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException timeout) {
                    break;
                }
                String host = packet.getAddress().getHostAddress();
                String text = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                Server server = verify(text, nonce, pinnedKey, host);
                if (server != null) found.put(server.id, server);
            }
        }
    }

    private static void httpSweep(int port, String nonce, String pinnedKey, Map<String, Server> found) {
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (InterfaceAddress address : privateInterfaces()) {
            byte[] ip = address.getAddress().getAddress();
            for (int last = 1; last < 255; last++) {
                final String host = (ip[0] & 255) + "." + (ip[1] & 255) + "." + (ip[2] & 255) + "." + last;
                pool.submit(() -> {
                    String text = httpGet("http://" + host + ":" + port + "/hello?nonce=" + nonce, 700);
                    Server server = text == null ? null : verify(text, nonce, pinnedKey, host);
                    if (server != null) found.put(server.id, server);
                });
            }
        }
        pool.shutdown();
        try {
            pool.awaitTermination(8, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
    }

    static String httpGet(String address, int timeoutMs) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            if (connection.getResponseCode() != 200) return null;
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] chunk = new byte[2048];
                for (int n; (n = in.read(chunk)) > 0 && out.size() < 8192; ) out.write(chunk, 0, n);
                return out.toString("UTF-8");
            } finally {
                connection.disconnect();
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** This device's private IPv4 interfaces (Wi-Fi / Ethernet). */
    private static List<InterfaceAddress> privateInterfaces() {
        List<InterfaceAddress> list = new ArrayList<>();
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback()) continue;
                for (InterfaceAddress address : nic.getInterfaceAddresses())
                    if (address.getAddress() instanceof Inet4Address && isPrivate(address.getAddress().getHostAddress()))
                        list.add(address);
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    public static boolean isPrivate(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int a = Integer.parseInt(parts[0]), b = Integer.parseInt(parts[1]);
            return a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
        } catch (NumberFormatException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------- answer

    /** Checks an answer: shape, nonce, key↔id, Ed25519 signature, private host, pinned key. */
    static Server verify(String text, String nonce, String pinnedKey, String host) {
        try {
            if (!isPrivate(host)) return null;
            Map<String, String> h = parseFlatJson(text);
            if (!"1".equals(h.get("v")) || !nonce.equals(h.get("nonce"))) return null;
            String key = h.get("key"), id = h.get("id");
            if (key == null || id == null) return null;
            if (pinnedKey != null && !pinnedKey.equals(key)) return null;
            byte[] spki = base64Decode(key);
            if (spki.length != 44) return null;
            if (!id.equals(hex(sha("SHA-256", spki)).substring(0, 16).toUpperCase())) return null;
            int port = Integer.parseInt(h.get("port"));
            if (port < 1 || port > 65535) return null;
            String name = h.get("name") == null ? "" : h.get("name");
            String ver = h.get("ver") == null ? "" : h.get("ver");
            String signed = MAGIC + "|" + id + "|" + name + "|" + h.get("port") + "|" + ver + "|" + nonce;
            byte[] publicKey = new byte[32];
            System.arraycopy(spki, 12, publicKey, 0, 32);
            if (!Ed25519.verify(publicKey, signed.getBytes(StandardCharsets.UTF_8), base64Decode(h.get("sig")))) return null;
            return new Server(id, key, name.length() > 80 ? name.substring(0, 80) : name, port, ver, host);
        } catch (Exception e) {
            return null;
        }
    }

    /** A one-level JSON object of strings, numbers and booleans (the beacon's answer). */
    static Map<String, String> parseFlatJson(String text) {
        Map<String, String> map = new HashMap<>();
        int i = text.indexOf('{') + 1;
        while (i > 0 && i < text.length()) {
            while (i < text.length() && " \t\r\n,".indexOf(text.charAt(i)) >= 0) i++;
            if (i >= text.length() || text.charAt(i) == '}') break;
            StringBuilder key = new StringBuilder();
            i = readString(text, i, key);
            while (text.charAt(i) == ' ' || text.charAt(i) == ':') i++;
            if (text.charAt(i) == '"') {
                StringBuilder value = new StringBuilder();
                i = readString(text, i, value);
                map.put(key.toString(), value.toString());
            } else {
                int start = i;
                while (i < text.length() && ",} \r\n\t".indexOf(text.charAt(i)) < 0) i++;
                map.put(key.toString(), text.substring(start, i));
            }
        }
        return map;
    }

    private static int readString(String text, int i, StringBuilder out) {
        if (text.charAt(i) != '"') throw new IllegalArgumentException("string expected");
        for (i++; ; i++) {
            char c = text.charAt(i);
            if (c == '"') return i + 1;
            if (c != '\\') {
                out.append(c);
                continue;
            }
            char e = text.charAt(++i);
            switch (e) {
                case 'n': out.append('\n'); break;
                case 't': out.append('\t'); break;
                case 'r': out.append('\r'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u': out.append((char) Integer.parseInt(text.substring(i + 1, i + 5), 16)); i += 4; break;
                default: out.append(e);
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String newNonce() {
        byte[] bytes = new byte[12];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder();
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        for (int i = 0; i < 12; i += 3) {
            int n = ((bytes[i] & 255) << 16) | ((bytes[i + 1] & 255) << 8) | (bytes[i + 2] & 255);
            for (int s = 18; s >= 0; s -= 6) out.append(alphabet.charAt((n >> s) & 63));
        }
        return out.toString();
    }

    static byte[] base64Decode(String text) {
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int buffer = 0, bits = 0;
        for (char c : text.toCharArray()) {
            if (c == '=') break;
            int v = c == '-' ? 62 : c == '_' ? 63 : alphabet.indexOf(c);
            if (v < 0) throw new IllegalArgumentException("base64");
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write((buffer >> bits) & 255);
            }
        }
        return out.toByteArray();
    }

    static byte[] sha(String algorithm, byte[]... parts) throws Exception {
        MessageDigest digest = MessageDigest.getInstance(algorithm);
        for (byte[] part : parts) digest.update(part);
        return digest.digest();
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b & 255));
        return out.toString();
    }

    /** Ed25519 signature check (RFC 8032), verification only; Android 7+ has no built-in one. */
    static final class Ed25519 {
        private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
        private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
        private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
        private static final BigInteger I = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
        private static final BigInteger[] B;

        static {
            BigInteger y = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
            BigInteger x = recoverX(y, 0);
            B = new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
        }

        private static BigInteger recoverX(BigInteger y, int sign) {
            if (y.compareTo(P) >= 0) return null;
            BigInteger yy = y.multiply(y);
            BigInteger xx = yy.subtract(BigInteger.ONE).multiply(D.multiply(yy).add(BigInteger.ONE).modInverse(P)).mod(P);
            if (xx.signum() == 0) return sign == 0 ? BigInteger.ZERO : null;
            BigInteger x = xx.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
            if (!x.multiply(x).subtract(xx).mod(P).equals(BigInteger.ZERO)) x = x.multiply(I).mod(P);
            if (!x.multiply(x).subtract(xx).mod(P).equals(BigInteger.ZERO)) return null;
            if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
            return x;
        }

        private static BigInteger[] decode(byte[] s) {
            byte[] le = s.clone();
            int sign = (le[31] >> 7) & 1;
            le[31] &= 0x7f;
            BigInteger y = littleEndian(le);
            BigInteger x = recoverX(y, sign);
            if (x == null) return null;
            return new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
        }

        private static BigInteger littleEndian(byte[] bytes) {
            byte[] be = new byte[bytes.length + 1];
            for (int i = 0; i < bytes.length; i++) be[bytes.length - i] = bytes[i];
            return new BigInteger(be);
        }

        private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
            BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
            BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
            BigInteger c = p[3].multiply(BigInteger.valueOf(2)).multiply(D).multiply(q[3]).mod(P);
            BigInteger d = p[2].multiply(BigInteger.valueOf(2)).multiply(q[2]).mod(P);
            BigInteger e = b.subtract(a), f = d.subtract(c), g = d.add(c), h = b.add(a);
            return new BigInteger[] {e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P)};
        }

        private static BigInteger[] multiply(BigInteger s, BigInteger[] point) {
            BigInteger[] result = {BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO};
            BigInteger[] q = point;
            for (int i = 0; i < s.bitLength(); i++) {
                if (s.testBit(i)) result = add(result, q);
                q = add(q, q);
            }
            return result;
        }

        private static boolean same(BigInteger[] p, BigInteger[] q) {
            return p[0].multiply(q[2]).subtract(q[0].multiply(p[2])).mod(P).signum() == 0
                && p[1].multiply(q[2]).subtract(q[1].multiply(p[2])).mod(P).signum() == 0;
        }

        static boolean verify(byte[] publicKey, byte[] message, byte[] signature) {
            try {
                if (publicKey.length != 32 || signature.length != 64) return false;
                byte[] rBytes = new byte[32], sBytes = new byte[32];
                System.arraycopy(signature, 0, rBytes, 0, 32);
                System.arraycopy(signature, 32, sBytes, 0, 32);
                BigInteger s = littleEndian(sBytes);
                if (s.compareTo(L) >= 0) return false;
                BigInteger[] a = decode(publicKey), r = decode(rBytes);
                if (a == null || r == null) return false;
                BigInteger h = littleEndian(sha("SHA-512", rBytes, publicKey, message)).mod(L);
                return same(multiply(s, B), add(r, multiply(h, a)));
            } catch (Exception e) {
                return false;
            }
        }
    }
}
