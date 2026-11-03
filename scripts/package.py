#!/usr/bin/env python3
"""Build an allowlisted source distribution; never package recordings or native libraries."""
import argparse
import hashlib
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "server.py", "launcher.py", "launch.command", "launch.bat", "launch.sh", ".gitignore")


def source_files():
    for name in TOP_FILES:
        path = ROOT / name
        if path.is_file(): yield path
    for directory, patterns in (("web", ("*.html", "*.css", "*.js", "*.svg", ".nojekyll")),
                                ("backend", ("*.java",)), ("scripts", ("*.py",)),
                                ("tests", ("*.py", "*.js")), ("docs", ("*.md",)),
                                (".github/workflows", ("*.yml",))):
        for pattern in patterns:
            yield from sorted((ROOT / directory).glob(pattern))


def build(output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(set(source_files()))
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, "OpenBCI-Research-Workbench/" + path.relative_to(ROOT).as_posix())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(digest + "  " + output.name + "\n")
    print(f"Packaged {len(files)} files: {output.name} ({output.stat().st_size:,} bytes)")
    print("SHA256: " + digest)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "dist/OpenBCI-Research-Workbench.zip"))
    build(parser.parse_args().output)
