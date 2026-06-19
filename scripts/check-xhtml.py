#!/usr/bin/env python3
"""Fail the build if any addon XHTML fragment is not well-formed.

Zotero preference panes and other addon UI are XHTML *fragments* injected into
a host document that declares the XUL and XHTML namespaces. A single malformed
construct (an unclosed comment, a mismatched tag) makes Zotero's strict parser
abort and silently renders a blank / non-loading pane — which is exactly how a
dropped `-->` shipped unnoticed for three releases.

This guard parses every `addon/**/*.xhtml` inside a namespace-declaring wrapper
so the fragment form and the `html:` prefix are valid, and reports the first
structural error per file. Placeholder tokens like `__addonRef__` are fine —
they are just attribute text to the parser.
"""

import glob
import sys
import xml.etree.ElementTree as ET

# Namespaces Zotero's host document provides to injected fragments.
WRAPPER_OPEN = (
    '<root '
    'xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" '
    'xmlns:html="http://www.w3.org/1999/xhtml">'
)
WRAPPER_CLOSE = "</root>"


def main() -> int:
    files = sorted(glob.glob("addon/**/*.xhtml", recursive=True))
    if not files:
        print("check-xhtml: no addon XHTML files found", file=sys.stderr)
        return 1

    failures = []
    for path in files:
        with open(path, encoding="utf-8") as fh:
            body = fh.read()
        try:
            ET.fromstring(WRAPPER_OPEN + body + WRAPPER_CLOSE)
        except ET.ParseError as exc:
            failures.append((path, exc))

    if failures:
        print("check-xhtml: malformed XHTML fragment(s):", file=sys.stderr)
        for path, exc in failures:
            print(f"  {path}: {exc}", file=sys.stderr)
        return 1

    print(f"check-xhtml: {len(files)} XHTML fragment(s) well-formed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
