#!/usr/bin/env python3
"""
Safe one-shot hex → design-token replacement for index.html.

Strategy:
  1. Find all <script>…</script> blocks AND all SVG color attributes
     (fill="#…", stroke="#…", color="#…", stop-color="#…") and stash
     them behind placeholders so they're untouched.
  2. Apply hex → var(--token) replacements to everything else
     (CSS in <style> blocks and inside style="…" attributes).
  3. Restore the stashed regions verbatim.

Mapping prefers SCALE tokens (--neutral-900) over SEMANTIC tokens
(--text-primary) because semantic intent can't be inferred from a hex
value alone — semantic upgrades happen later, by hand.
"""

import re
import sys
from pathlib import Path

# Mapping is case-insensitive on the hex side. Order matters: 6-digit
# hex listed before 3-digit so the longer pattern always wins.
HEX_TO_TOKEN = {
    # Brand
    "#001f5c": "var(--brand-navy)",
    "#2563eb": "var(--brand-accent)",

    # Neutral scale (canonical Slate-based palette)
    "#ffffff": "var(--neutral-0)",
    "#fff":    "var(--neutral-0)",
    "#f8fafc": "var(--neutral-50)",
    "#f1f5f9": "var(--neutral-100)",
    "#e2e8f0": "var(--neutral-200)",
    "#cbd5e1": "var(--neutral-300)",
    "#94a3b8": "var(--neutral-400)",
    "#64748b": "var(--neutral-500)",
    "#475569": "var(--neutral-600)",
    "#334155": "var(--neutral-700)",
    "#1e293b": "var(--neutral-800)",
    "#0f172a": "var(--neutral-900)",

    # Semantic — success
    "#10b981": "var(--success)",
    "#16a34a": "var(--success-strong)",
    "#059669": "var(--success-deep)",
    "#34d399": "var(--success-soft)",
    "#f0fdf4": "var(--success-bg)",
    "#bbf7d0": "var(--success-border)",

    # Semantic — danger
    "#ef4444": "var(--danger)",
    "#dc2626": "var(--danger-strong)",
    "#a32d2d": "var(--danger-deep)",
    "#fef2f2": "var(--danger-bg)",
    "#fecaca": "var(--danger-border)",

    # Semantic — warning
    "#f59e0b": "var(--warning)",
    "#f97316": "var(--warning-strong)",
    "#fef3c7": "var(--warning-bg)",
    "#fcd34d": "var(--warning-border)",

    # Semantic — info
    "#3b82f6": "var(--info)",
    "#1d4ed8": "var(--info-deep)",
    "#60a5fa": "var(--info-soft)",
    "#eef4ff": "var(--info-bg)",
    "#bfd0ff": "var(--info-border)",

    # Data series (chart palette)
    "#8b5cf6": "var(--series-4)",
    "#ec4899": "var(--series-5)",
    "#06b6d4": "var(--series-6)",
}


def main(path: str) -> None:
    p = Path(path)
    src = p.read_text()
    original_len = len(src)

    # 1. Stash regions we must NOT touch.
    stash: list[str] = []

    def _stash(m: re.Match) -> str:
        stash.append(m.group(0))
        return f"\x00STASH{len(stash)-1}\x00"

    # Order matters: scripts first (so SVG inside scripts is preserved
    # via the script stash), then standalone SVG attrs.
    src = re.sub(
        r"<script\b[\s\S]*?</script>",
        _stash, src, flags=re.IGNORECASE,
    )
    src = re.sub(
        r'\b(?:fill|stroke|color|stop-color|flood-color|lighting-color)\s*=\s*"[^"]*"',
        _stash, src, flags=re.IGNORECASE,
    )
    # Protect <meta> tags wholesale — content="…" attribute can hold a hex
    # (e.g. theme-color) but does NOT support CSS var().
    src = re.sub(
        r"<meta\b[^>]*>", _stash, src, flags=re.IGNORECASE,
    )

    # 2. Apply hex → token substitutions, longest hex first to avoid
    #    "#fff" matching inside "#ffffff".
    replacements = 0
    for hex_code in sorted(HEX_TO_TOKEN, key=len, reverse=True):
        token = HEX_TO_TOKEN[hex_code]
        # Word-boundary at the END so #fff doesn't match the start of #ffffff;
        # hex must be followed by a non-hex char or end-of-string.
        pattern = re.compile(re.escape(hex_code) + r"(?![0-9A-Fa-f])", re.IGNORECASE)
        src, n = pattern.subn(token, src)
        replacements += n

    # 3. Restore stashed regions.
    def _unstash(m: re.Match) -> str:
        return stash[int(m.group(1))]

    src = re.sub(r"\x00STASH(\d+)\x00", _unstash, src)

    p.write_text(src)
    new_len = len(src)
    print(f"OK {path}: {replacements} replacements, "
          f"{original_len} → {new_len} bytes "
          f"({stash.__len__()} regions protected)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: hex_to_tokens.py <file> [<file>…]", file=sys.stderr)
        sys.exit(1)
    for path in sys.argv[1:]:
        main(path)
