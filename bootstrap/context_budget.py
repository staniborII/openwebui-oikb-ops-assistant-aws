"""Choose the messages sent to the model for one oikb Ops Assistant turn.

The chat stored in Open WebUI stays complete. This module only builds the
shorter payload. The cap follows the selected base model. Open WebUI runs the
same source as a filter and cannot import this package, so filter_source()
returns one self-contained script.
"""

from __future__ import annotations

import copy
import json
import re

FILTER_ID = "oikb_context_budget"
# Request caps, in estimated tokens. Characters divided by 4 can undercount,
# so a cap stays near five eighths of the text that model accepts and leaves
# room for the reply. gpt-4o-mini's 128,000-token window uses 80,000.
# gpt-5-mini's 272,000-token input limit uses 170,000. gpt-4.1-mini's
# 1,047,576-token window uses 650,000. An unknown model uses the smallest cap.
_MODEL_BUDGETS = (
    ("gpt-4.1-mini", 650_000),
    ("gpt-5-mini", 170_000),
    ("gpt-4o-mini", 80_000),
)
BUDGET_TOKENS = 80_000
RECENT_TURNS = 4
STUB_MARK = "Omitted because it did not fit the context budget."
TOO_LONG_NOTE = "This question is too long to send. Ask the person to send a smaller question."

_EXTENSIONS = ("py", "md", "yml", "yaml", "toml", "json", "go", "rs", "ts", "js")
_PATH_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-")
_ISSUE_RE = re.compile(r"#\d+|\bissues?/\d+\b", re.I)
_COMMIT_RE = re.compile(
    r"(?:commit|sha)\s+([0-9a-fA-F]{7,64})\b"
    r"|/commit/([0-9a-fA-F]{7,64})\b"
    r"|@([0-9a-fA-F]{7,64})\b"
    r"|(?<![0-9a-fA-F])([0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9a-fA-F])",
    re.I,
)
_SOURCE_RE = re.compile(r"<source\b[^>]*>.*?</source>", re.I | re.S)
_CONNECTOR_RE = re.compile(
    r"\b(?:github|gitlab|confluence|s3|gcs|azure|sharepoint|bookstack|bitbucket):[A-Za-z0-9_./-]*[A-Za-z0-9_/-]",
    re.I,
)


def budget_tokens(model_id: str) -> int:
    """Return the request cap for a base model id, or the smallest cap."""
    name = model_id.strip().lower()
    for prefix, cap in _MODEL_BUDGETS:
        if name == prefix or name.startswith(prefix + "-"):
            return cap
    return BUDGET_TOKENS


def base_model_id(body, model) -> str:
    """Read the base model id Open WebUI stored on the assistant."""
    if isinstance(model, dict):
        info = model.get("info") if isinstance(model.get("info"), dict) else {}
        for source in (info, model):
            base = source.get("base_model_id")
            if isinstance(base, str) and base.strip():
                return base.strip()
    if isinstance(body, dict):
        selected = body.get("model")
        if isinstance(selected, str) and selected.strip():
            return selected.strip()
    return ""


def fit_request(messages: list, tools=None, budget: int = BUDGET_TOKENS) -> list:
    """Return a new message list that fits the budget when history can yield."""
    copied = copy.deepcopy(messages)
    return _fit(copied, tools, budget)


def estimate_tokens(messages: list, tools=None) -> int:
    payload = {"messages": messages}
    if tools:
        payload["tools"] = tools
    text = json.dumps(payload, ensure_ascii=False, default=str)
    return len(text) // 4


def _fit(messages: list, tools, budget: int) -> list:
    rest = [message for message in messages if message.get("role") != "system"]
    turns = _turns(rest)
    recent = turns[-RECENT_TURNS:]
    older = turns[:-RECENT_TURNS]
    identifiers = _identifiers(_current_question(recent))
    kept_older = [turn for turn in older if _shares(turn, identifiers)]

    def chosen(older_turns: list) -> list:
        keep = {id(message) for turn in older_turns + recent for message in turn}
        selected = [
            copy.deepcopy(message)
            for message in messages
            if message.get("role") == "system" or id(message) in keep
        ]
        return _repair_tool_pairs(selected)

    while kept_older and estimate_tokens(chosen(kept_older), tools) > budget:
        kept_older.pop(0)

    fitted = chosen(kept_older)
    if estimate_tokens(fitted, tools) > budget:
        fitted = _stub_tool_results(fitted, tools, budget)
    while len(recent) > 1 and estimate_tokens(fitted, tools) > budget:
        recent.pop(0)
        fitted = chosen(kept_older)
        if estimate_tokens(fitted, tools) > budget:
            fitted = _stub_tool_results(fitted, tools, budget)
    return _fit_current_question(fitted, tools, budget)


def _turns(messages: list) -> list:
    turns = []
    current: list = []
    for message in messages:
        if message.get("role") == "user" and current:
            turns.append(current)
            current = [message]
        else:
            current.append(message)
    if current:
        turns.append(current)
    return turns


def _current_question(turns: list) -> str:
    for turn in reversed(turns):
        for message in reversed(turn):
            if message.get("role") == "user":
                return _text(message)
    return ""


def _shares(turn: list, identifiers: set) -> bool:
    if not identifiers:
        return False
    found = set()
    for message in turn:
        found.update(_identifiers(_text(message)))
    return bool(found & identifiers)


def _identifiers(text: str) -> set:
    found = {f"path:{match}" for match in _paths(text)}
    found.update(f"issue:{match}" for match in _issue_numbers(text))
    found.update(f"commit:{match}" for match in _commit_ids(text))
    found.update(f"connector:{match.lower().rstrip('/')}" for match in _CONNECTOR_RE.findall(text))
    return found


def _paths(text: str) -> list:
    found = []
    start = 0
    while True:
        dot = text.find(".", start)
        if dot < 0:
            return found
        end = dot + 1
        extension = []
        while end < len(text) and text[end].isascii() and text[end].isalpha():
            extension.append(text[end])
            end += 1
        if "".join(extension) in _EXTENSIONS and (end == len(text) or not (text[end].isalnum() or text[end] == "_")):
            cursor = dot
            while cursor > 0 and text[cursor - 1] in _PATH_CHARS:
                cursor -= 1
            if cursor < dot:
                token = text[cursor:end]
                while token.startswith("./"):
                    token = token[2:]
                if token:
                    found.append(token)
        start = dot + 1


def _commit_ids(text: str) -> set:
    found = set()
    for groups in _COMMIT_RE.findall(text):
        token = next((part for part in groups if part), "")
        if token:
            found.add(token.lower())
    return found


def _issue_numbers(text: str) -> set:
    numbers = set()
    for match in _ISSUE_RE.findall(text):
        digits = re.search(r"\d+", match)
        if digits:
            numbers.add(digits.group(0))
    return numbers


def _text(message: dict) -> str:
    parts = []
    content = message.get("content")
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                for key in ("text", "content"):
                    if isinstance(part.get(key), str):
                        parts.append(part[key])
    for call in message.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        function = call.get("function") or {}
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            parts.append(arguments)
        elif isinstance(arguments, (dict, list)):
            parts.append(json.dumps(arguments, ensure_ascii=False, default=str))
    return "\n".join(parts)


def _call_id(call: dict) -> str:
    return str(call.get("id") or call.get("call_id") or "")


def _repair_tool_pairs(messages: list) -> list:
    answered = {
        str(message.get("tool_call_id"))
        for message in messages
        if message.get("role") == "tool" and message.get("tool_call_id")
    }
    kept = []
    for message in messages:
        calls = message.get("tool_calls")
        if message.get("role") == "assistant" and calls:
            message = dict(message)
            paired = [call for call in calls if _call_id(call) in answered]
            if paired:
                message["tool_calls"] = paired
            else:
                message.pop("tool_calls", None)
            if not paired and not _text(message).strip():
                continue
        kept.append(message)

    still_called = set()
    for message in kept:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict) and _call_id(call):
                still_called.add(_call_id(call))
    return [
        message
        for message in kept
        if message.get("role") != "tool" or str(message.get("tool_call_id")) in still_called
    ]


def _stub_tool_results(messages: list, tools, budget: int) -> list:
    fitted = messages
    while estimate_tokens(fitted, tools) > budget:
        index = _largest_stubbable(fitted)
        if index is None:
            break
        fitted = list(fitted)
        fitted[index] = _stub_message(fitted, index)
    return fitted


def _largest_stubbable(messages: list):
    best = None
    best_size = 0
    for index, message in enumerate(messages):
        if message.get("role") != "tool":
            continue
        text = _tool_context(messages, index)
        if STUB_MARK in text:
            continue
        stub = _stub_text(text, _tool_name(_matching_call(messages, index)))
        if len(stub) >= len(text):
            continue
        if len(text) > best_size:
            best = index
            best_size = len(text)
    return best


def _stub_message(messages: list, index: int) -> dict:
    message = dict(messages[index])
    call = _matching_call(messages, index)
    message["content"] = _stub_text(_tool_context(messages, index), _tool_name(call))
    return message


def _matching_call(messages: list, index: int):
    wanted = messages[index].get("tool_call_id")
    if not wanted:
        return None
    for other in messages:
        if other.get("role") != "assistant":
            continue
        for call in other.get("tool_calls") or []:
            if isinstance(call, dict) and _call_id(call) == str(wanted):
                return call
    return None


def _tool_name(call) -> str:
    if not isinstance(call, dict):
        return "that tool"
    function = call.get("function") or {}
    name = function.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return "that tool"


def _tool_context(messages: list, index: int) -> str:
    parts = [_text(messages[index])]
    call = _matching_call(messages, index)
    if call:
        parts.append(_text({"tool_calls": [call]}))
    return "\n".join(parts)


def _stub_text(text: str, tool_name: str) -> str:
    label = _label(text)
    return f"{label}. {STUB_MARK} Do not call {tool_name} with the same arguments again."


def _label(text: str) -> str:
    identifiers = _identifiers(text)
    for prefix in ("path:", "issue:", "commit:", "connector:"):
        matches = sorted(item[len(prefix) :] for item in identifiers if item.startswith(prefix))
        if matches:
            value = matches[0]
            if prefix == "issue:":
                return f"#{value}"
            return value
    return "that source"


def _fit_current_question(messages: list, tools, budget: int) -> list:
    if estimate_tokens(messages, tools) <= budget:
        return messages
    index = None
    for cursor in range(len(messages) - 1, -1, -1):
        message = messages[cursor]
        if isinstance(message, dict) and message.get("role") == "user":
            index = cursor
            break
    if index is None:
        return messages
    fitted = list(messages)
    text = _message_text(messages[index].get("content")).strip()
    stripped = _SOURCE_RE.sub("", text).strip()
    if stripped and stripped != text:
        updated = dict(messages[index])
        updated["content"] = stripped
        fitted[index] = updated
        if estimate_tokens(fitted, tools) <= budget:
            return fitted
    if estimate_tokens([fitted[index]]) <= budget:
        return fitted
    noted = dict(fitted[index])
    noted["content"] = TOO_LONG_NOTE
    fitted[index] = noted
    return fitted


def _message_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                for key in ("text", "content"):
                    if isinstance(part.get(key), str):
                        parts.append(part[key])
        return "\n".join(parts)
    return ""


def fallback_messages(messages: list) -> list:
    """System messages plus the current question, used when fitting fails."""
    system = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("role") == "system"
    ]
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return copy.deepcopy(system + [message])
    return copy.deepcopy(list(messages))


def filter_source() -> str:
    from pathlib import Path

    text = Path(__file__).read_text(encoding="utf-8")
    logic = text.partition("\ndef filter_source(")[0].rstrip() + "\n"
    return logic + _FILTER_CLASS


_FILTER_CLASS = '''
class Filter:
    async def request(self, body, __user__=None, __model__=None):
        if not isinstance(body, dict):
            return body
        messages = body.get("messages")
        if not isinstance(messages, list):
            return body
        try:
            cap = budget_tokens(base_model_id(body, __model__))
            body["messages"] = fit_request(messages, body.get("tools"), cap)
        except Exception as exc:
            print(f"oikb context budget used a shorter fallback: {type(exc).__name__}")
            try:
                body["messages"] = fallback_messages(messages)
            except Exception:
                print("oikb context budget left the request unchanged")
        return body
'''
