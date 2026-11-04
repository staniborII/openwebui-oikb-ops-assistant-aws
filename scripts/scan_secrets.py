"""Fail when a commit would add a secret or a private path.

Used by the git pre-commit hook and by the Cursor shell hook.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS access key"),
    (re.compile(r"ASIA[0-9A-Z]{16}"), "AWS temporary key"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "GitHub fine-grained token"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "GitHub token"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "API key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"(?i)aws_secret_access_key\s*=\s*\S+"), "AWS secret access key"),
    (
        re.compile(
            r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{12,}['\"]"
        ),
        "hardcoded credential",
    ),
]

SKIP_PARTS = {
    ".git",
    "node_modules",
    "cdk.out",
    "__pycache__",
}


def _blocked_path(path: str) -> str | None:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    name = Path(normalized).name
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        return "env file"
    if normalized == "private" or normalized.startswith("private/"):
        return "private path"
    if normalized == "docs/private" or normalized.startswith("docs/private/"):
        return "private path"
    if normalized.endswith((".ts", ".tsx", ".js", ".mjs")) and "arn:aws:" in _read(normalized):
        return "AWS ARN in source"
    return None


def _read(relative: str) -> str:
    file_path = ROOT / relative
    if not file_path.is_file():
        return ""
    try:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def findings_in_text(relative: str, text: str) -> list[str]:
    found: list[str] = []
    blocked = _blocked_path(relative)
    if blocked and blocked != "AWS ARN in source":
        found.append(f"{relative}: {blocked}")
    if relative.endswith((".ts", ".tsx", ".js", ".mjs")) and "arn:aws:" in text:
        found.append(f"{relative}: AWS ARN in source")
    for pattern, label in SECRET_PATTERNS:
        if pattern.search(text):
            found.append(f"{relative}: {label}")
    return found


def staged_paths() -> list[str] | None:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stderr.strip() or "git diff failed", file=sys.stderr)
        return None
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def scan_paths(paths: list[str]) -> list[str]:
    found: list[str] = []
    for relative in paths:
        parts = set(Path(relative).parts)
        if parts & SKIP_PARTS:
            continue
        found.extend(findings_in_text(relative, _read(relative)))
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--file", action="append", default=[])
    args = parser.parse_args()

    if args.staged:
        paths = staged_paths()
        if paths is None:
            return 1
    else:
        paths = args.file

    found = scan_paths(paths)
    if not found:
        return 0
    print("Commit blocked. Remove secrets or account-specific values:", file=sys.stderr)
    for item in found:
        print(f"  {item}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
