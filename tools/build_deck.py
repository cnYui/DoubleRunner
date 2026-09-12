"""Builds docs/presentation.html from tools/deck_template.html.

Every {{shot:NAME}} placeholder is replaced with the matching PNG in
docs/screens/ as a data URI, so the deck is one self-contained file that
opens from disk, publishes as an artifact, and prints to PDF.
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "tools" / "deck_template.html"
SCREENS = ROOT / "docs" / "screens"
OUT = ROOT / "docs" / "presentation.html"

PLACEHOLDER = re.compile(r"\{\{shot:([a-z0-9-]+)\}\}")


def data_uri(name):
    path = SCREENS / (name + ".png")
    if not path.exists():
        raise SystemExit("missing screenshot: " + str(path))
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def main():
    html = TEMPLATE.read_text(encoding="utf-8")
    used = []

    def replace(match):
        name = match.group(1)
        used.append(name)
        return data_uri(name)

    html = PLACEHOLDER.sub(replace, html)
    OUT.write_text(html, encoding="utf-8", newline="\n")
    kb = OUT.stat().st_size / 1024
    print("wrote {} ({:.0f} KB) with {} screenshots ({} unique)".format(
        OUT.relative_to(ROOT), kb, len(used), len(set(used))))
    unused = sorted(p.stem for p in SCREENS.glob("*.png") if p.stem not in set(used))
    if unused:
        print("unused screenshots:", ", ".join(unused))
    return 0


if __name__ == "__main__":
    sys.exit(main())
