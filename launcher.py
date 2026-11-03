#!/usr/bin/env python3
"""Start the local workbench, or reopen an already-running instance."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import webbrowser


def main():
    if sys.version_info < (3, 10):
        print("需要 Python 3.10 或更新版本：https://www.python.org/downloads/")
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENBCI_PORT", "8765")))
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    try:
        with urllib.request.urlopen(url + "api/status", timeout=1) as response:
            status = json.load(response)
        if {"running", "mode", "samples", "channels"} <= status.keys():
            print("工作台已在运行，正在打开：" + url)
            webbrowser.open(url)
            return 0
        raise ValueError("Port occupied by another service")
    except urllib.error.URLError:
        pass
    except (ValueError, OSError):
        print(f"端口 {args.port} 已被其他服务占用。请设置 OPENBCI_PORT 后重试。")
        return 1
    os.chdir(Path(__file__).resolve().parent)
    import server
    sys.argv = ["server.py", "--port", str(args.port), "--open-browser"]
    server.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
