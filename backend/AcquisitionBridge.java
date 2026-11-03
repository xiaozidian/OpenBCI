import brainflow.BoardShim;
import brainflow.BrainFlowInputParams;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** The acquisition thread alone owns the BrainFlow session. No display filtering is applied. */
class AcquisitionBridge {
    private static final BlockingQueue<String> commands = new LinkedBlockingQueue<>();
    private static final List<Map<String, Object>> pending = new ArrayList<>();
    private static int[] eeg;
    private static int timestampRow, packageRow, markerRow;
    private static long samplesSeen = 0;

    private static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof String) {
            StringBuilder s = new StringBuilder("\"");
            for (char c : ((String)value).toCharArray()) {
                switch (c) {
                    case '"': s.append("\\\""); break;
                    case '\\': s.append("\\\\"); break;
                    case '\n': s.append("\\n"); break;
                    case '\r': s.append("\\r"); break;
                    case '\t': s.append("\\t"); break;
                    default: if (c < 32) s.append(String.format("\\u%04x", (int)c)); else s.append(c);
                }
            }
            return s.append('"').toString();
        }
        if (value instanceof Number) {
            double v = ((Number)value).doubleValue();
            return Double.isFinite(v) ? value.toString() : "null";
        }
        if (value instanceof Boolean) return value.toString();
        List<String> parts = new ArrayList<>();
        if (value instanceof Map) {
            for (Object entryObject : ((Map<?,?>)value).entrySet()) {
                Map.Entry<?,?> entry = (Map.Entry<?,?>)entryObject;
                parts.add(json(entry.getKey().toString()) + ":" + json(entry.getValue()));
            }
            return "{" + String.join(",", parts) + "}";
        }
        if (value.getClass().isArray()) {
            for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++)
                parts.add(json(java.lang.reflect.Array.get(value, i)));
        } else if (value instanceof Iterable) {
            for (Object item : (Iterable<?>)value) parts.add(json(item));
        } else return json(value.toString());
        return "[" + String.join(",", parts) + "]";
    }

    private static Map<String,Object> record(Object... fields) {
        Map<String,Object> result = new LinkedHashMap<>();
        for (int i=0; i<fields.length; i+=2) result.put(fields[i].toString(), fields[i+1]);
        return result;
    }
    private static void emit(Map<String,Object> value) {
        System.out.println(json(value));
        System.out.flush();
    }
    private static double now() { return System.currentTimeMillis() / 1000.0; }
    private static void event(Map<String,Object> marker, String kind, Object... fields) {
        Map<String,Object> result = new LinkedHashMap<>(marker);
        result.put("type", "event"); result.put("kind", kind);
        for (int i=0; i<fields.length; i+=2) result.put(fields[i].toString(), fields[i+1]);
        emit(result);
    }

    private static void drain(BoardShim board) throws Exception {
        double[][] raw = board.get_board_data();
        if (raw.length == 0 || raw[0].length == 0) return;
        double[][] channels = new double[eeg.length][];
        for (int i=0; i<eeg.length; i++) channels[i] = raw[eeg[i]];
        emit(record("type", "data", "sample_start_index", samplesSeen, "timestamps", raw[timestampRow], "eeg", channels,
            "markers", raw[markerRow], "package_numbers", raw[packageRow], "raw_rows", raw));
        for (int sample=0; sample<raw[markerRow].length; sample++) {
            double value = raw[markerRow][sample];
            if (value == 0.0) continue;
            for (Iterator<Map<String,Object>> it=pending.iterator(); it.hasNext();) {
                Map<String,Object> marker = it.next();
                if (((Number)marker.get("value")).doubleValue() == value) {
                    event(marker, "observed", "observed_at", raw[timestampRow][sample],
                        "observed_sample_index", samplesSeen + sample,
                        "observed_package_number", raw[packageRow][sample], "received_at", now(),
                        "observed_bridge_monotonic_ns", System.nanoTime());
                    it.remove(); break;
                }
            }
        }
        samplesSeen += raw[markerRow].length;
    }

    private static void handleMarker(BoardShim board, String command) throws Exception {
        String[] parts = command.split("\t", -1);
        if (parts.length != 6 || !parts[0].equals("marker"))
            throw new IllegalArgumentException("Invalid bridge command");
        Map<String,Object> marker = record("event_id", Long.parseLong(parts[1]),
            "value", Double.parseDouble(parts[2]), "requested_at", Double.parseDouble(parts[3]),
            "label", new String(Base64.getDecoder().decode(parts[4]), StandardCharsets.UTF_8),
            "server_request_monotonic_ns", Long.parseLong(parts[5]),
            "bridge_received_monotonic_ns", System.nanoTime());
        try {
            board.insert_marker(((Number)marker.get("value")).doubleValue());
            marker.put("accepted_at", now());
            marker.put("insert_return_monotonic_ns", System.nanoTime());
            pending.add(marker);
            event(marker, "accepted");
        } catch (Exception error) {
            event(marker, "failed", "error", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    public static void main(String[] args) {
        BoardShim board = null;
        boolean prepared = false, streaming = false, failed = false;
        Thread input = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
                String line;
                while ((line=reader.readLine()) != null) commands.put(line);
            } catch (Exception ignored) {
            } finally { commands.offer("stop"); }
        }, "command-reader");
        input.setDaemon(true); input.start();
        try {
            String mode = args.length > 0 ? args[0] : "synthetic";
            int id;
            BrainFlowInputParams params = new BrainFlowInputParams();
            if (mode.equals("synthetic")) id = -1;
            else if (mode.equals("cyton_daisy")) {
                id = 2;
                String port = args.length > 1 ? args[1] : "";
                boolean windows = System.getProperty("os.name").toLowerCase(Locale.ROOT).startsWith("windows");
                boolean validPort = windows ? port.matches("(?i)COM[1-9][0-9]*") :
                    port.matches("/dev/(cu\\.[A-Za-z0-9._-]+|tty(USB|ACM)[0-9]+)") && Files.exists(Path.of(port));
                if (!validPort ||
                    port.toLowerCase(Locale.ROOT).contains("bluetooth") ||
                    port.toLowerCase(Locale.ROOT).contains("debug"))
                    throw new IllegalArgumentException("Select an existing Cyton USB serial receiver");
                params.set_serial_port(port);
                params.set_timeout(10);
            } else throw new IllegalArgumentException("Unknown acquisition mode");
            eeg = BoardShim.get_eeg_channels(id);
            timestampRow = BoardShim.get_timestamp_channel(id);
            packageRow = BoardShim.get_package_num_channel(id);
            markerRow = BoardShim.get_marker_channel(id);
            int rate = BoardShim.get_sampling_rate(id);
            emit(record("type", "status", "phase", "preparing", "mode", mode,
                "board_id", id, "sample_rate", rate, "channels", eeg.length,
                "eeg_rows", eeg, "timestamp_row", timestampRow, "package_number_row", packageRow,
                "marker_row", markerRow, "num_rows", BoardShim.get_num_rows(id),
                "brainflow_version", BoardShim.get_version(), "eeg_unit", "uV",
                "timestamp_unit", "Unix seconds", "marker_timing", "software marker; no hardware synchronization guarantee"));
            board = new BoardShim(id, params);
            board.prepare_session(); prepared = true;
            if (id == 2) {
                String response = board.config_board("C");
                emit(record("type", "status", "phase", "preparing", "daisy_config_response", response));
                if (response.toLowerCase(Locale.ROOT).contains("no daisy"))
                    throw new IllegalStateException("Cyton reported no Daisy; refusing a 16-channel session");
                String compact = response.replaceAll("\\s+", "");
                if (compact.contains("8$$$") || response.toLowerCase(Locale.ROOT).contains("failure"))
                    throw new IllegalStateException("Cyton did not enable 16-channel mode; response saved in metadata");
                if (!compact.contains("16$$$"))
                    throw new IllegalStateException("Unrecognized firmware response; could not confirm 16 channels. Response saved in metadata; stream not started");
                emit(record("type", "status", "phase", "preparing", "daisy_hardware_validation", "16-channel response confirmed; signal quality not validated"));
            }
            if (!commands.contains("stop")) {
                board.start_stream(rate * 120); streaming = true;
                emit(record("type", "status", "phase", "running", "started_at", now()));
                long nextDrain = System.nanoTime() + 250_000_000L;
                boolean stop = false;
                while (!stop) {
                    long remaining = Math.max(0, nextDrain - System.nanoTime());
                    String command = commands.poll(remaining, TimeUnit.NANOSECONDS);
                    if ("stop".equals(command)) stop = true;
                    else if (command != null) handleMarker(board, command);
                    if (System.nanoTime() >= nextDrain) {
                        drain(board);
                        nextDrain = System.nanoTime() + 250_000_000L;
                    }
                }
            }
        } catch (Exception error) {
            failed = true;
            error.printStackTrace(System.err);
            emit(record("type", "error", "error", error.getClass().getSimpleName() + ": " + error.getMessage()));
        } finally {
            // Stop the producer, preserve its last buffered samples, then release the session.
            if (streaming) {
                try { board.stop_stream(); } catch (Exception error) { failed=true; error.printStackTrace(System.err); }
                try { drain(board); } catch (Exception error) { failed=true; error.printStackTrace(System.err); }
            }
            for (Map<String,Object> marker : pending) event(marker, "unobserved", "ended_at", now());
            if (prepared) {
                try { board.release_session(); } catch (Exception error) { failed=true; error.printStackTrace(System.err); }
            }
            emit(record("type", "status", "phase", failed ? "error" : "stopped", "ended_at", now()));
        }
        if (failed) System.exit(1);
    }
}
