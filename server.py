#!/usr/bin/env python3
"""Local research acquisition service. Uses the installed GUI's BrainFlow, not a new dependency."""
from __future__ import annotations
import argparse
import base64
from collections import deque
import csv
from datetime import datetime, timezone
import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import platform
import signal
import shutil
import subprocess
import threading
import time
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit
import uuid
import webbrowser
import zipfile

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
APP = Path(os.environ.get("OPENBCI_GUI_DIR", "/Applications/OpenBCI_GUI.app"))


def runtime_paths():
    """Locate an existing GUI installation; no native libraries are redistributed."""
    roots = [APP, ROOT / "OpenBCI_GUI", ROOT.parent / "OpenBCI_GUI"]
    libraries = []
    for root in roots:
        for relative in ("Contents/Java", "Java", "lib", ""):
            directory = root / relative
            if (directory / "brainflow.jar").is_file(): libraries.append(directory)
    if os.environ.get("OPENBCI_BRAINFLOW_DIR"):
        libraries.insert(0, Path(os.environ["OPENBCI_BRAINFLOW_DIR"]))
    libraries = [p for p in libraries if (p / "brainflow.jar").is_file()]
    executables = []
    if os.environ.get("OPENBCI_JAVA"): executables.append(Path(os.environ["OPENBCI_JAVA"]))
    for root in roots:
        executables.extend(sorted(root.glob("Contents/PlugIns/*/Contents/Home/bin/java")))
        executables.extend(root / p for p in ("java/bin/java", "java/bin/java.exe", "jdk/bin/java", "jdk/bin/java.exe"))
    if os.environ.get("JAVA_HOME"):
        executables.append(Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java"))
    if shutil.which("java"): executables.append(Path(shutil.which("java")))
    executable = next((p for p in executables if p.is_file()), None)
    if not executable or not libraries:
        raise ValueError("未找到 OpenBCI GUI 的 Java 17 / BrainFlow 库。请安装官方 GUI；其他安装位置可设置 OPENBCI_GUI_DIR。详见使用说明。")
    return executable, libraries[0]


def serial_ports():
    if os.name == "nt":
        import winreg
        ports = []
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM") as key:
                for index in range(winreg.QueryInfoKey(key)[1]): ports.append(winreg.EnumValue(key, index)[1])
        except OSError: pass
        return sorted(set(ports))
    if platform.system() == "Linux":
        return sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*"))
    return sorted(p for p in glob.glob("/dev/cu.*")
                  if "bluetooth" not in p.lower() and "debug" not in p.lower())


class Acquisition:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.reader = None
        self.chunks = deque()
        self.events = deque(maxlen=10000)
        self.chunk_seq = self.event_seq = self.marker_id = 0
        self.info = dict(running=False, phase="stopped", mode="synthetic", sample_rate=250,
                         channels=16, error=None, recording=None, samples=0)
        self.metadata = {}
        self.folder = None
        self.runtime = None
        self.raw_file = self.event_file = self.log_file = None
        self.raw_writer = self.event_writer = None

    def status(self):
        with self.lock:
            return {**self.info, "api_version": 2}

    def _save_metadata(self):
        if self.folder:
            self.metadata.update(final_status=dict(self.info), updated_at=time.time())
            temp = self.folder / "metadata.json.tmp"
            temp.write_text(json.dumps(self.metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(self.folder / "metadata.json")

    def _event(self, event):
        self.event_seq += 1
        event = {**event, "seq": self.event_seq}
        self.events.append(event)
        if self.event_writer:
            self.event_writer.writerow([event.get(k, "") for k in
                ("seq", "event_id", "kind", "value", "requested_at", "accepted_at", "observed_at", "received_at",
                 "observed_sample_index", "observed_package_number", "server_request_monotonic_ns",
                 "bridge_received_monotonic_ns", "insert_return_monotonic_ns", "observed_bridge_monotonic_ns")]
                + [json.dumps(event.get("label", ""), ensure_ascii=False),
                   json.dumps(event.get("error", ""), ensure_ascii=False)])
            self.event_file.flush()

    def start(self, mode, port):
        if mode not in ("synthetic", "cyton_daisy"):
            raise ValueError("请选择模拟数据或 Cyton + Daisy。")
        if mode == "cyton_daisy" and port not in serial_ports():
            raise ValueError("没有选中可用的 USB 串口，请插入 Cyton 接收器后刷新。")
        java, library = runtime_paths()
        with self.lock:
            if self.info["running"] or self.process is not None:
                raise ValueError("已有采集会话正在运行或清理中。")
            self.chunks.clear()
            self.events.clear()
            name = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + mode + "_" + uuid.uuid4().hex[:6]
            self.folder = ROOT / "recordings" / name
            self.folder.mkdir(parents=True)
            runtime = ROOT / ".runtime" / name
            runtime.mkdir(parents=True, exist_ok=True)
            self.runtime = runtime
            self.info = dict(running=True, phase="starting", mode=mode,
                             sample_rate=250 if mode == "synthetic" else 125, channels=16,
                             error=None, recording="recordings/" + name, samples=0, serial_port=port)
            self.metadata = dict(schema_version=1, created_at=time.time(),
                created_utc=datetime.now(timezone.utc).isoformat(), mode=mode, serial_port=port,
                source="BrainFlow from user-installed OpenBCI GUI; actual BrainFlow version recorded separately",
                raw_csv="raw.csv", events_tsv="events.tsv", raw_csv_layout="One sample per row; all BrainFlow rows retained as columns",
                eeg_unit="uV", filters_applied_to_recording=False,
                timestamp_semantics="BrainFlow sample timestamp, Unix seconds. Cyton Daisy uses host receive/merge time, not the hardware ADC sampling clock",
                marker_semantics="Software marker queued via insert_marker; requested_at and observed_at must not be treated as synchronized hardware triggers",
                event_time_semantics="requested_at is server request handling time, not browser click or stimulus presentation. received_at and observed_bridge_monotonic_ns are observation after a 250 ms drain poll, not hardware latency",
                monotonic_clock_semantics="server_request_monotonic_ns uses Python monotonic_ns; bridge_* and insert_return_* use Java nanoTime. Compare differences only within the same clock domain; do not subtract browser performance.now values",
                daisy_hardware_validation="not performed" if mode == "synthetic" else "requested; inspect final status",
                package_number_note="Raw BrainFlow package sequence retained; a sequence discontinuity alone is not a validated hardware packet-loss estimate")
            self.raw_file = (self.folder / "raw.csv").open("w", encoding="utf-8", newline="")
            self.raw_writer = None
            self.event_file = (self.folder / "events.tsv").open("w", encoding="utf-8", newline="")
            self.event_writer = csv.writer(self.event_file, delimiter="\t")
            self.event_writer.writerow(["seq", "event_id", "kind", "value", "requested_at", "accepted_at",
                                        "observed_at", "received_at", "observed_sample_index", "observed_package_number",
                                        "server_request_monotonic_ns", "bridge_received_monotonic_ns",
                                        "insert_return_monotonic_ns", "observed_bridge_monotonic_ns", "label_json", "error_json"])
            self.event_file.flush()
            self.log_file = (self.folder / "bridge.log").open("w", encoding="utf-8")
            command = [str(java), "-Djava.io.tmpdir=" + str(runtime), "-Djna.tmpdir=" + str(runtime),
                       "-cp", str(library / "*"), str(ROOT / "backend/AcquisitionBridge.java"), mode, port]
            try:
                self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=self.log_file, text=True, encoding="utf-8", bufsize=1, cwd=ROOT)
                self._save_metadata()
            except Exception:
                self.info.update(running=False, phase="error", error="无法启动采集进程。")
                for handle in (self.raw_file, self.event_file, self.log_file):
                    if handle: handle.close()
                self.process = None
                shutil.rmtree(runtime, ignore_errors=True)
                self._save_metadata()
                raise
            self.reader = threading.Thread(target=self._read, args=(self.process,), daemon=True,
                                           name="brainflow-output")
            self.reader.start()
            return {"ok": True, **self.info}

    def _receive(self, message):
        kind = message.get("type")
        with self.lock:
            if kind == "status":
                self.metadata.update({k: v for k, v in message.items() if k != "type"})
                for key in ("sample_rate", "channels", "started_at", "ended_at"):
                    if key in message: self.info[key] = message[key]
                phase = message.get("phase", "starting")
                if phase == "preparing": phase = "starting"
                # Process ownership remains active until stdout has been drained and files closed.
                self.info["phase"] = phase
                self._save_metadata()
            elif kind == "error":
                self.info.update(error=message.get("error", "采集失败。"), phase="error")
                self.metadata["bridge_error"] = message.get("error")
            elif kind == "event":
                self._event({k: v for k, v in message.items() if k != "type"})
            elif kind == "data":
                count = len(message["timestamps"])
                raw = message.pop("raw_rows")
                if not self.raw_writer:
                    labels = ["row_" + str(i) for i in range(len(raw))]
                    for key, suffix in (("timestamp_row", "timestamp_s"), ("marker_row", "marker"),
                                        ("package_number_row", "package_number")):
                        row = self.metadata.get(key)
                        if row is not None: labels[row] += "_" + suffix
                    for channel, row in enumerate(self.metadata.get("eeg_rows", []), 1):
                        labels[row] += f"_eeg{channel:02d}_uV"
                    self.raw_writer = csv.writer(self.raw_file)
                    self.raw_writer.writerow(labels)
                    self.metadata["raw_csv_columns"] = labels
                self.raw_writer.writerows(zip(*raw))
                self.raw_file.flush()
                self.chunk_seq += 1
                chunk = {k: v for k, v in message.items() if k != "type"}
                chunk["seq"] = self.chunk_seq
                self.chunks.append(chunk)
                self.info["samples"] += count
                # Bound by sample count, not wall-clock jumps in sample timestamps.
                limit = self.info["sample_rate"] * 30
                total = sum(len(c["timestamps"]) for c in self.chunks)
                while len(self.chunks) > 1 and total > limit:
                    total -= len(self.chunks.popleft()["timestamps"])

    def _read(self, process):
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    with self.lock:
                        self.log_file.write(line)
                        self.log_file.flush()
                    continue
                self._receive(message)
        except Exception as error:
            with self.lock:
                self.info.update(error="采集数据读取失败：" + str(error), phase="error")
            if process.poll() is None: process.terminate()
        finally:
            try: code = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); code = process.wait()
            with self.lock:
                if code and not self.info["error"]:
                    self.info["error"] = "采集进程异常退出；详情已保存到本次记录的 bridge.log。"
                self.info.update(running=False, phase="error" if self.info["error"] else "stopped",
                                 ended_at=time.time())
                self.metadata["bridge_exit_code"] = code
                self.metadata["sample_count"] = self.info["samples"]
                self._save_metadata()
                for handle in (self.raw_file, self.event_file, self.log_file, process.stdout, process.stdin):
                    if handle:
                        try: handle.close()
                        except OSError: pass
                self.raw_writer = self.event_writer = None
                self.process = None
                if self.runtime: shutil.rmtree(self.runtime, ignore_errors=True)

    def stop(self):
        with self.lock:
            process, reader = self.process, self.reader
            if process is None: return {"ok": True, **self.info}
            self.info["phase"] = "stopping"
            try:
                process.stdin.write("stop\n"); process.stdin.flush()
            except (OSError, ValueError): pass
        if reader and reader is not threading.current_thread(): reader.join(timeout=15)
        if reader and reader.is_alive():
            with self.lock:
                self.info["error"] = "采集进程停止超时，已终止；本次记录可能不完整。"
            process.terminate()
            reader.join(timeout=6)
            if reader.is_alive(): process.kill(); reader.join(timeout=3)
        return {"ok": not bool(self.status()["error"]), **self.status()}

    def marker(self, label, value):
        if not isinstance(label, str) or len(label) > 256:
            raise ValueError("事件名称应为不超过 256 字的文字。")
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1_000_000:
            raise ValueError("事件编号应为 1 到 1000000 的整数。")
        with self.lock:
            if self.process is None or self.info["phase"] != "running":
                raise ValueError("请在数据流开始后添加事件。")
            self.marker_id += 1
            event = dict(event_id=self.marker_id, kind="requested", label=label, value=value,
                         requested_at=time.time(), server_request_monotonic_ns=time.monotonic_ns())
            encoded = base64.b64encode(label.encode("utf-8")).decode("ascii")
            command = f"marker\t{self.marker_id}\t{value}\t{event['requested_at']}\t{encoded}\t{event['server_request_monotonic_ns']}\n"
            try:
                self.process.stdin.write(command); self.process.stdin.flush()
            except (OSError, ValueError) as error:
                raise ValueError("事件未提交，采集进程已结束。") from error
            self._event(event)
            return {"ok": True, "event_id": self.marker_id, "requested_at": event["requested_at"]}

    def data_after(self, after):
        with self.lock:
            return {"chunks": [c for c in self.chunks if c["seq"] > after], "next_seq": self.chunk_seq}

    def events_after(self, after):
        with self.lock:
            return {"events": [e for e in self.events if e["seq"] > after], "next_seq": self.event_seq}


ACQUISITION = Acquisition()


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenBCIResearch/0.1"
    def log_message(self, format, *args): pass

    def _reply(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes): body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

    def _allowed(self, write=False):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in hosts:
            self._reply(403, {"error": "Only local requests are accepted."}); return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {"http://" + host for host in hosts}:
            self._reply(403, {"error": "Cross-origin requests are not accepted."}); return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self._reply(403, {"error": "Cross-site requests are not accepted."}); return False
        if write and self.headers.get_content_type() != "application/json":
            self._reply(415, {"error": "Use application/json."}); return False
        return True

    def do_GET(self):
        if not self._allowed(): return
        path = urlsplit(self.path)
        try:
            query = parse_qs(path.query)
            after = max(0, int(query.get("after", ["0"])[0]))
            if path.path == "/api/status": self._reply(200, ACQUISITION.status())
            elif path.path == "/api/data": self._reply(200, ACQUISITION.data_after(after))
            elif path.path == "/api/events": self._reply(200, ACQUISITION.events_after(after))
            elif path.path == "/api/ports": self._reply(200, {"ports": serial_ports()})
            elif path.path == "/api/recording": self._recording()
            elif path.path.startswith("/api/"): self._reply(404, {"error": "Unknown endpoint"})
            else:
                relative = unquote(path.path).lstrip("/") or "index.html"
                file = (WEB / relative).resolve()
                if not file.is_relative_to(WEB.resolve()) or any(p.startswith(".") for p in Path(relative).parts) or not file.is_file():
                    self._reply(404, {"error": "Not found"}); return
                mime = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
                self._reply(200, file.read_bytes(), mime + ("; charset=utf-8" if mime.startswith("text/") or mime == "application/javascript" else ""))
        except (ValueError, OSError): self._reply(400, {"error": "Invalid request"})

    def _recording(self):
        # A stopped session is immutable; archive it without holding the acquisition lock.
        with ACQUISITION.lock:
            if ACQUISITION.process is not None or ACQUISITION.info["running"]:
                self._reply(409, {"error": "请先停止采集，再下载完整记录。原始数据已持续保存在本机。"}); return
            folder = ACQUISITION.folder
            if not folder or not ACQUISITION.info["samples"]:
                self._reply(404, {"error": "尚无可下载的采集记录。"}); return
        with tempfile.TemporaryFile() as archive:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name in ("raw.csv", "events.tsv", "metadata.json", "bridge.log"):
                    file = folder / name
                    if file.is_file(): output.write(file, folder.name + "/" + name)
            length = archive.tell(); archive.seek(0)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{folder.name}.zip"')
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try: shutil.copyfileobj(archive, self.wfile)
            except (BrokenPipeError, ConnectionResetError): pass

    def do_POST(self):
        if not self._allowed(write=True): return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 8192: raise ValueError("请求过大。")
            data = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data, dict): raise ValueError("请求格式错误。")
            path = urlsplit(self.path).path
            if path == "/api/start": result = ACQUISITION.start(data.get("mode", "synthetic"), data.get("port", ""))
            elif path == "/api/stop": result = ACQUISITION.stop()
            elif path == "/api/marker": result = ACQUISITION.marker(data.get("label", ""), data.get("value", 1))
            else: self._reply(404, {"error": "Unknown endpoint"}); return
            self._reply(200, result)
        except (ValueError, json.JSONDecodeError) as error:
            self._reply(400, {"ok": False, "error": str(error)})
        except Exception:
            self._reply(500, {"ok": False, "error": "本地服务发生错误，请查看终端与本次记录。"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENBCI_PORT", "8765")))
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}/"
    print("OpenBCI 学术原型：" + url, flush=True)
    print("按 Ctrl+C 结束服务。原始数据保存在本目录 recordings/。", flush=True)
    if args.open_browser: webbrowser.open(url)
    def interrupted(signum, frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try: server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt: pass
    finally:
        ACQUISITION.stop()
        server.server_close()


if __name__ == "__main__": main()
