"""Gate cdk deploy on a fresh synth, and scan git commits for secrets."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAMP = ROOT / ".cursor" / "synth-stamp.json"
sys.path.insert(0, str(ROOT / "scripts"))

from scan_secrets import findings_in_text  # noqa: E402

DEPLOY = re.compile(
    r"(?:^|[;&|]\s*)(?:npx\s+|pnpm(?:\s+exec)?\s+|yarn\s+)?cdk\s+deploy\b"
)
SYNTH = re.compile(
    r"(?:^|[;&|]\s*)(?:npx\s+|pnpm(?:\s+exec)?\s+|yarn\s+)?cdk\s+(?:synth|synthesize)\b"
)
COMMIT = re.compile(r"(?:^|[;&|]\s*)git\s+commit\b")

HASH_ROOTS = ("infra", "bootstrap", "containers")
HASH_FILES = ("cdk.json", "package.json", "package-lock.json")


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")


def allow() -> int:
    emit({"permission": "allow"})
    return 0


def deny(user_message: str, agent_message: str) -> int:
    emit(
        {
            "permission": "deny",
            "user_message": user_message,
            "agent_message": agent_message,
        }
    )
    return 0


def load_input() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def command_of(data: dict) -> str:
    command = data.get("command") or data.get("cmd") or ""
    return command if isinstance(command, str) else ""


def exit_code_of(data: dict) -> int | None:
    for key in ("exitCode", "exit_code", "code", "status"):
        value = data.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.lstrip("-").isdigit():
            return int(value)
    return None


def tree_hash() -> str:
    digest = hashlib.sha256()
    files: list[Path] = []
    for name in HASH_FILES:
        candidate = ROOT / name
        if candidate.is_file():
            files.append(candidate)
    for name in HASH_ROOTS:
        directory = ROOT / name
        if not directory.is_dir():
            continue
        files.extend(
            path
            for path in directory.rglob("*")
            if path.is_file()
            and "node_modules" not in path.parts
            and "cdk.out" not in path.parts
            and "__pycache__" not in path.parts
        )
    for path in sorted(files):
        relative = path.relative_to(ROOT).as_posix()
        digest.update(relative.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def write_stamp() -> None:
    STAMP.parent.mkdir(parents=True, exist_ok=True)
    STAMP.write_text(
        json.dumps({"tree": tree_hash()}),
        encoding="utf-8",
    )


def synth_is_fresh() -> bool:
    if not STAMP.is_file():
        return False
    try:
        saved = json.loads(STAMP.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return saved.get("tree") == tree_hash()


def handle_before(data: dict) -> int:
    command = command_of(data)
    if DEPLOY.search(command) and not synth_is_fresh():
        return deny(
            "cdk deploy was blocked. Run cdk synth successfully after the latest infra change.",
            "cdk deploy is blocked until cdk synth exits 0 and infra/, bootstrap/, and containers/ are unchanged since that synth.",
        )
    if COMMIT.search(command):
        from scan_secrets import staged_paths, scan_paths

        paths = staged_paths()
        if paths is None:
            return deny(
                "Commit blocked because the staged-file check could not be run.",
                "git diff --cached failed, so the commit was blocked.",
            )
        found = scan_paths(paths)
        inline = findings_in_text("<command>", command)
        found.extend(inline)
        if found:
            return deny(
                "Commit blocked because a secret or account-specific value was found.",
                "Commit blocked:\n" + "\n".join(found),
            )
    return allow()


def handle_after(data: dict) -> int:
    command = command_of(data)
    code = exit_code_of(data)
    if SYNTH.search(command) and code == 0:
        write_stamp()
    emit({})
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "before"
    data: dict = {}
    try:
        data = load_input()
        if mode == "after":
            return handle_after(data)
        return handle_before(data)
    except Exception as exc:  # noqa: BLE001 — a hook must always return JSON
        command = command_of(data)
        if DEPLOY.search(command) or COMMIT.search(command):
            return deny(
                "The safety hook failed closed.",
                f"Safety hook error: {exc}",
            )
        return allow()


if __name__ == "__main__":
    sys.exit(main())
