"""Configure Open WebUI, sync the oikb repository, and record the evaluation answers.

Exit 0 when setup itself succeeded. A weak answer is recorded and still exits 0.
Exit 1 when setup failed. The workflow then leaves the daemon stopped.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime, timezone

import boto3
import requests

from bootstrap.context_budget import FILTER_ID, filter_source

LIBRARY_QUESTIONS = [
    "Where in the code are the oikb commands defined?",
    "Where in the code are GitHub webhooks processed?",
    "Which connectors does oikb currently provide?",
]
GITHUB_QUESTIONS = [
    "A customer's Google Drive sync re-uploads a file on every run when the filename contains a slash. Is that a known issue on open-webui/oikb? Look up the open issues and cite the number.",
    "What landed on main of open-webui/oikb in the latest commits? Name the commit shas and what each merge changed. Use GitHub, and cite the shas.",
    "Which open pull requests on open-webui/oikb change sync behavior or ignore rules? Cite the numbers and titles.",
]
QUESTIONS = LIBRARY_QUESTIONS + GITHUB_QUESTIONS
WRITE_MARKERS = (
    "create_",
    "update_",
    "delete_",
    "push_",
    "merge_",
    "add_",
    "close_",
    "fork_",
    "submit_",
    "assign_",
    "dismiss_",
    "resolve_",
    "reopen_",
    "lock_",
    "unlock_",
    "enable_",
    "disable_",
    "write",
)
PATH_RE = re.compile(r"[\w./-]+\.(?:py|md|yml|yaml|toml|json|go|rs|ts|js)")
CONNECTOR_RE = re.compile(r"github|gitlab|confluence|s3|gcs|azure|sharepoint|bookstack|bitbucket", re.I)
GITHUB_RE = re.compile(r"#\d+|\bissues?/\d+\b|\b[0-9a-f]{12,40}\b", re.I)
SYSTEM_PROMPT = (
    "You are the oikb Ops Assistant. Answer from the oikb knowledge base and the "
    "read-only GitHub tools. Name the file or connector you used."
)
ASSISTANT_DESCRIPTION = (
    "Answers from the oikb knowledge base, and from read-only GitHub when a "
    "question needs a live issue, commit, or pull request."
)


class SetupError(Exception):
    pass


class FatalSetupError(SetupError):
    pass


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    base = os.environ["WEBUI_BASE_URL"].rstrip("/")
    stage = os.environ["STAGE"]
    report: dict = {
        "stage": stage,
        "infrastructure_ok": False,
        "evaluation_ok": False,
        "model": "oikb Ops Assistant",
        "questions": [],
    }
    try:
        session = requests.Session()
        wait_until("database health", lambda: check_health(session, base), timeout=1200)
        token = wait_until("admin sign-in", lambda: sign_in(session, base), timeout=300)
        session.headers["Authorization"] = f"Bearer {token}"
        enable_signup(session, base)
        api_key = ensure_api_key(session, base)
        knowledge = ensure_knowledge(session, base)
        kb_id = str(knowledge["id"])
        share_knowledge(session, base, kb_id)
        store_secret(os.environ["WEBUI_API_KEY_SECRET_ARN"], api_key)
        store_secret(os.environ["KB_ID_SECRET_ARN"], kb_id)
        server_id, tool_id = register_github_mcp(session, base, os.environ["MCP_URL"])
        base_model = wait_until("base model", lambda: choose_base_model(session, base), timeout=300)
        ensure_context_filter(session, base)
        import_assistant(session, base, base_model, knowledge, tool_id)
        share_assistant(session, base)
        sync_repository(base, api_key, kb_id)
        wait_until("file processing", lambda: files_ready(session, base, kb_id), timeout=1800)
        report["knowledge_base_id"] = kb_id
        report["mcp_server_id"] = server_id
        report["base_model_id"] = base_model
        # Chat reads the in-memory model list. This rebuilds it after the assistant was saved.
        reload_models(session, base)
        report["questions"] = ask_questions(session, base, tool_id)
        report["infrastructure_ok"] = True
        report["evaluation_ok"] = all(item["passed"] for item in report["questions"])
        write_report(report)
        logging.info("setup finished evaluation_ok=%s", report["evaluation_ok"])
    except Exception as exc:
        report["error"] = str(exc)
        logging.exception("setup failed")
        try:
            write_report(report)
        except Exception:
            logging.exception("could not write the failure report")
        raise SystemExit(1) from exc


def wait_until(label: str, fn, timeout: int, interval: int = 15):
    deadline = time.time() + timeout
    last = "not started"
    while time.time() < deadline:
        try:
            return fn()
        except FatalSetupError:
            raise
        except Exception as exc:
            last = str(exc)
            logging.info("%s not ready: %s", label, last)
            time.sleep(interval)
    raise SetupError(f"{label} did not succeed within {timeout}s: {last}")


def check_health(session: requests.Session, base: str) -> None:
    response = session.get(f"{base}/health/db", timeout=10)
    if response.status_code != 200:
        raise SetupError(f"/health/db returned {response.status_code}")


def sign_in(session: requests.Session, base: str) -> str:
    response = session.post(
        f"{base}/api/v1/auths/signin",
        json={
            "email": os.environ["WEBUI_ADMIN_EMAIL"],
            "password": os.environ["WEBUI_ADMIN_PASSWORD"],
        },
        timeout=30,
    )
    if response.status_code != 200:
        raise SetupError(f"sign-in returned {response.status_code}")
    token = response.json().get("token")
    if not token:
        raise SetupError("sign-in returned no token")
    return str(token)


def ensure_api_key(session: requests.Session, base: str) -> str:
    current = session.get(f"{base}/api/v1/auths/api_key", timeout=30)
    if current.status_code == 200:
        key = (current.json() or {}).get("api_key")
        if key:
            return str(key)
    created = session.post(f"{base}/api/v1/auths/api_key", timeout=30)
    if created.status_code != 200:
        raise SetupError(f"API key creation returned {created.status_code}")
    key = (created.json() or {}).get("api_key")
    if not key:
        raise SetupError("API key creation returned no key")
    return str(key)


def store_secret(arn: str, value: str) -> None:
    boto3.client("secretsmanager", region_name="us-east-1").put_secret_value(
        SecretId=arn,
        SecretString=value,
    )


PUBLIC_READ = [{"principal_type": "user", "principal_id": "*", "permission": "read"}]


def enable_signup(session: requests.Session, base: str) -> None:
    # The first admin account turns signup off. Put the .env choice back.
    current = session.get(f"{base}/api/v1/auths/admin/config", timeout=30)
    if current.status_code != 200:
        raise SetupError(f"admin config returned {current.status_code}")
    config = current.json()
    if not isinstance(config, dict):
        raise SetupError("admin config returned an unexpected body")
    signup = os.environ.get("ENABLE_SIGNUP", "true").strip().lower() == "true"
    role = os.environ.get("DEFAULT_USER_ROLE", "user").strip().lower()
    if role not in ("pending", "user", "admin"):
        raise SetupError(f"DEFAULT_USER_ROLE {role} is not pending, user, or admin")
    config["ENABLE_SIGNUP"] = signup
    config["DEFAULT_USER_ROLE"] = role
    if config.get("I18N") is None:
        config.pop("I18N", None)
    updated = session.post(f"{base}/api/v1/auths/admin/config", json=config, timeout=30)
    if updated.status_code != 200:
        raise SetupError(f"admin config update returned {updated.status_code}: {_error_detail(updated)}")
    saved = updated.json()
    if not isinstance(saved, dict) or bool(saved.get("ENABLE_SIGNUP")) != signup or saved.get("DEFAULT_USER_ROLE") != role:
        raise SetupError("signup settings were not saved")
    logging.info("signup enabled=%s default role=%s", signup, role)


def share_knowledge(session: requests.Session, base: str, kb_id: str) -> None:
    updated = session.post(
        f"{base}/api/v1/knowledge/{kb_id}/access/update",
        json={"access_grants": PUBLIC_READ},
        timeout=30,
    )
    if updated.status_code != 200:
        raise SetupError(f"knowledge access update returned {updated.status_code}: {_error_detail(updated)}")


def share_assistant(session: requests.Session, base: str) -> None:
    updated = session.post(
        f"{base}/api/v1/models/model/access/update",
        json={"id": "oikb-ops-assistant", "access_grants": PUBLIC_READ},
        timeout=30,
    )
    if updated.status_code != 200:
        raise SetupError(f"model access update returned {updated.status_code}: {_error_detail(updated)}")


def ensure_knowledge(session: requests.Session, base: str) -> dict:
    existing = session.get(f"{base}/api/v1/knowledge/", timeout=30)
    if existing.status_code != 200:
        raise SetupError(f"knowledge list returned {existing.status_code}")
    for item in as_list(existing.json()):
        if item.get("name") == "oikb" and item.get("id"):
            return item
    created = session.post(
        f"{base}/api/v1/knowledge/create",
        json={"name": "oikb", "description": "Public repository open-webui/oikb"},
        timeout=30,
    )
    if created.status_code not in (200, 201):
        raise SetupError(f"knowledge create returned {created.status_code}")
    body = created.json()
    if isinstance(body, dict) and body.get("id"):
        return body
    raise SetupError("knowledge create returned no id")


def register_github_mcp(session: requests.Session, base: str, github_mcp_url: str) -> tuple[str, str]:
    connection = {
        "url": github_mcp_url,
        "path": "/",
        "type": "mcp",
        "auth_type": "none",
        "key": "",
        "config": {"enable": True},
        "info": {"id": "github-mcp", "name": "GitHub", "description": "Read-only GitHub MCP"},
    }
    saved = wait_until("MCP registration", lambda: save_mcp(session, base, connection), timeout=600)
    server_id = str(((saved.get("info") or {}).get("id")) or "")
    if not server_id:
        raise SetupError("saved MCP connection has no info.id")
    specs = wait_until("MCP tool list", lambda: verify_mcp(session, base, saved), timeout=600)
    names = tool_names(specs)
    if not names:
        raise SetupError("MCP tool list was empty, so read-only mode could not be checked")
    writable = [name for name in names if any(marker in name.lower() for marker in WRITE_MARKERS)]
    if writable:
        raise SetupError(f"MCP exposed write tools: {', '.join(sorted(writable))}")
    logging.info("MCP tools are read-only (%s tools)", len(names))
    return server_id, f"server:mcp:{server_id}"


def save_mcp(session: requests.Session, base: str, connection: dict) -> dict:
    response = session.post(
        f"{base}/api/v1/configs/tool_servers",
        json={"TOOL_SERVER_CONNECTIONS": [connection]},
        timeout=60,
    )
    if response.status_code != 200:
        raise SetupError(f"tool server save returned {response.status_code}")
    connections = (response.json() or {}).get("TOOL_SERVER_CONNECTIONS") or []
    if not connections:
        raise SetupError("tool server save returned no connection")
    return connections[0]


def verify_mcp(session: requests.Session, base: str, connection: dict):
    response = session.post(f"{base}/api/v1/configs/tool_servers/verify", json=connection, timeout=60)
    if response.status_code != 200:
        raise SetupError(f"tool server verify returned {response.status_code}")
    return response.json()


def tool_names(payload) -> list[str]:
    specs = payload
    if isinstance(payload, dict):
        specs = payload.get("specs") or payload.get("tools") or []
    names = []
    for item in specs or []:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            function = item.get("function") or {}
            name = item.get("name") or function.get("name") or ""
            if name:
                names.append(str(name))
    return names


CHEAP_CHAT_MODELS = ("gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini")
NON_CHAT_MARKERS = (
    "transcribe",
    "realtime",
    "audio",
    "tts",
    "embed",
    "image",
    "whisper",
    "moderation",
    "instruct",
    "search",
    "codex",
    "diarize",
)


def choose_base_model(session: requests.Session, base: str) -> str:
    listed: list[str] = []
    for path in ("/api/models", "/api/v1/models"):
        response = session.get(f"{base}{path}", timeout=30)
        if response.status_code != 200:
            continue
        for item in as_list(response.json()):
            model_id = str(item.get("id") or "")
            if not model_id or item.get("base_model_id") or model_id == "oikb-ops-assistant":
                continue
            if not model_id.startswith("gpt-"):
                continue
            if any(marker in model_id for marker in NON_CHAT_MARKERS):
                continue
            listed.append(model_id)
        if listed:
            break
    for preferred in CHEAP_CHAT_MODELS:
        for model_id in listed:
            if model_id == preferred or model_id.startswith(f"{preferred}-"):
                logging.info("base model %s", model_id)
                return model_id
    raise SetupError(
        "no cheap chat model was listed. Expected one of: " + ", ".join(CHEAP_CHAT_MODELS)
    )


def ensure_context_filter(session: requests.Session, base: str) -> None:
    form = {
        "id": FILTER_ID,
        "name": "oikb context budget",
        "content": filter_source(),
        "meta": {
            "description": "Keeps oikb Ops Assistant model requests inside the context window.",
        },
    }
    current = session.get(f"{base}/api/v1/functions/id/{FILTER_ID}", timeout=30)
    if current.status_code == 200:
        saved = write_filter(session, base, form)
    else:
        created = session.post(f"{base}/api/v1/functions/create", json=form, timeout=60)
        if created.status_code == 200:
            saved = created.json()
        elif created.status_code == 400 and _filter_id_taken(created):
            saved = write_filter(session, base, form)
        else:
            raise SetupError(f"filter create returned {created.status_code}: {_error_detail(created)}")
    saved = filter_flags(session, base, saved)
    if saved.get("is_global") or not saved.get("is_active"):
        raise SetupError("context filter must be active and limited to this assistant")
    logging.info("context filter %s is active", FILTER_ID)


def _error_detail(response: requests.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail", payload)
    else:
        detail = response.text
    return str(detail).replace("\n", " ")[:200]


def _filter_id_taken(response: requests.Response) -> bool:
    return "id is already registered" in _error_detail(response).lower()


def write_filter(session: requests.Session, base: str, form: dict) -> dict:
    updated = session.post(f"{base}/api/v1/functions/id/{FILTER_ID}/update", json=form, timeout=60)
    if updated.status_code != 200:
        raise SetupError(f"filter update returned {updated.status_code}")
    body = updated.json()
    if not isinstance(body, dict):
        raise SetupError("filter update returned an unexpected body")
    return body


def filter_flags(session: requests.Session, base: str, saved: dict) -> dict:
    if not isinstance(saved, dict):
        raise SetupError("filter save returned an unexpected body")
    if saved.get("is_global"):
        saved = toggle_filter(session, base, "toggle/global")
        if saved.get("is_global"):
            raise SetupError("context filter is still global")
    if not saved.get("is_active"):
        saved = toggle_filter(session, base, "toggle")
        if not saved.get("is_active"):
            raise SetupError("context filter is not active")
    return saved


def toggle_filter(session: requests.Session, base: str, action: str) -> dict:
    toggled = session.post(f"{base}/api/v1/functions/id/{FILTER_ID}/{action}", timeout=30)
    if toggled.status_code != 200:
        raise SetupError(f"filter {action} returned {toggled.status_code}")
    body = toggled.json()
    if not isinstance(body, dict):
        raise SetupError(f"filter {action} returned an unexpected body")
    return body


def import_assistant(session: requests.Session, base: str, base_model: str, knowledge: dict, tool_id: str) -> None:
    model = {
        "id": "oikb-ops-assistant",
        "name": "oikb Ops Assistant",
        "base_model_id": base_model,
        "meta": {
            "description": ASSISTANT_DESCRIPTION,
            "knowledge": [
                {
                    "id": knowledge["id"],
                    "name": knowledge.get("name") or "oikb",
                    "type": knowledge.get("type") or "collection",
                }
            ],
            "toolIds": [tool_id],
            "filterIds": [FILTER_ID],
        },
        "params": {"system": SYSTEM_PROMPT},
    }
    response = session.post(f"{base}/api/v1/models/import", json={"models": [model]}, timeout=60)
    if response.status_code != 200:
        raise SetupError(f"model import returned {response.status_code}")


def sync_repository(base: str, api_key: str, kb_id: str) -> None:
    env = os.environ.copy()
    env["OPEN_WEBUI_URL"] = base
    env["OPEN_WEBUI_API_KEY"] = api_key
    completed = subprocess.run(
        ["oikb", "sync", "github:open-webui/oikb", "--kb-id", kb_id],
        env=env,
        text=True,
        capture_output=True,
        timeout=1800,
        check=False,
    )
    if completed.stdout:
        logging.info(completed.stdout[-4000:])
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "oikb sync failed")[-2000:]
        raise SetupError(detail)


def files_ready(session: requests.Session, base: str, kb_id: str) -> None:
    files = knowledge_files(session, base, kb_id)
    if not files:
        raise SetupError("knowledge base has no files yet")
    for item in files:
        status = file_status(item)
        if status in ("failed", "error"):
            raise FatalSetupError(f"file processing failed for {item.get('id')}")
        if status in ("pending", "processing", "uploading", "running"):
            raise SetupError(f"file {item.get('id')} is {status}")
    pending = session.get(f"{base}/api/v1/knowledge/{kb_id}/files/pending", timeout=30)
    if pending.status_code != 200:
        raise SetupError(f"knowledge pending list returned {pending.status_code}")
    waiting = as_list(pending.json())
    for item in waiting:
        if file_status(item) in ("failed", "error"):
            raise FatalSetupError(f"file processing failed for {item.get('id')}")
    if waiting:
        raise SetupError(f"{len(waiting)} files are still processing")


def knowledge_files(session: requests.Session, base: str, kb_id: str) -> list:
    collected = []
    total = None
    page = 1
    while page <= 20:
        response = session.get(
            f"{base}/api/v1/knowledge/{kb_id}/files",
            params={"page": page, "limit": 100},
            timeout=30,
        )
        if response.status_code != 200:
            raise SetupError(f"knowledge file list returned {response.status_code}")
        body = response.json() or {}
        if not isinstance(body, dict):
            raise SetupError("knowledge file list returned an unexpected body")
        total = int(body.get("total") or 0)
        items = body.get("items") or []
        collected.extend(items)
        if not items or len(collected) >= total:
            break
        page += 1
    if total == 0:
        return []
    return collected


def file_status(item: dict) -> str:
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    return str(item.get("status") or data.get("status") or meta.get("status") or "").lower()


def reload_models(session: requests.Session, base: str) -> None:
    try:
        response = session.get(f"{base}/api/models", timeout=30)
    except Exception as exc:
        logging.warning("model list reload failed: %s", exc)
        return
    if response.status_code != 200:
        logging.warning("model list reload returned %s", response.status_code)
        return
    ids = [str(item.get("id") or "") for item in as_list(response.json())]
    if "oikb-ops-assistant" in ids:
        logging.info("model list includes oikb-ops-assistant")
        return
    logging.warning("model list reload did not include oikb-ops-assistant")


def ask_questions(session: requests.Session, base: str, tool_id: str) -> list[dict]:
    results = []
    for index, question in enumerate(QUESTIONS):
        try:
            response = session.post(
                f"{base}/api/chat/completions",
                json={
                    "model": "oikb-ops-assistant",
                    "messages": [{"role": "user", "content": question}],
                    "stream": False,
                    "tool_ids": [tool_id],
                    # Native tool calling returns a tool call and no text when streaming is off.
                    "params": {"function_calling": "legacy"},
                },
                timeout=180,
            )
            if response.status_code != 200:
                raise SetupError(f"chat returned {response.status_code}")
            body = response.json()
            answer = str(((body.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
            cited = has_citation(body)
            live = index >= len(LIBRARY_QUESTIONS)
            specific = answer_is_specific(index, answer, live)
            results.append(
                {
                    "question": question,
                    "answer": answer,
                    "citation": cited,
                    "passed": specific and bool(answer.strip()) and (cited or live),
                }
            )
        except Exception as exc:
            results.append(
                {
                    "question": question,
                    "answer": "",
                    "citation": False,
                    "passed": False,
                    "error": str(exc),
                }
            )
    return results


def answer_is_specific(index: int, answer: str, live: bool) -> bool:
    if live:
        return bool(GITHUB_RE.search(answer))
    if index == 2:
        return bool(CONNECTOR_RE.search(answer))
    return bool(PATH_RE.search(answer))


def has_citation(payload: dict) -> bool:
    found = []
    message = ((payload.get("choices") or [{}])[0].get("message") or {})
    for source in (payload, message):
        if not isinstance(source, dict):
            continue
        for key in ("sources", "citations", "files"):
            value = source.get(key)
            if value:
                found.append(value)
    return bool(found)


def write_report(report: dict) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stage = report["stage"]
    body = json.dumps(report, indent=2).encode("utf-8")
    summary = summary_text(report).encode("utf-8")
    report_key = f"reports/{stage}/{stamp}.json"
    pointer = json.dumps({"report": report_key}, indent=2).encode("utf-8")
    client = boto3.client("s3", region_name="us-east-1")
    bucket = os.environ["BUCKET"]
    # The stamped object is the report. latest.json only names it, so the same
    # JSON is not stored twice. The pointer is written after that object and
    # before the summary, so a failed upload cannot name a missing report or
    # leave the summary ahead of the pointer.
    pairs = [
        (report_key, body, "application/json"),
        (f"reports/{stage}/latest.json", pointer, "application/json"),
        (f"reports/{stage}/latest.txt", summary, "text/plain"),
    ]
    for key, payload, content_type in pairs:
        client.put_object(Bucket=bucket, Key=key, Body=payload, ContentType=content_type)
    logging.info("wrote s3://%s/%s", bucket, report_key)


def summary_text(report: dict) -> str:
    lines = [
        f"stage: {report['stage']}",
        f"infrastructure_ok: {report['infrastructure_ok']}",
        f"evaluation_ok: {report['evaluation_ok']}",
        f"model: {report.get('model')}",
    ]
    if report.get("error"):
        lines.append(f"error: {report['error']}")
    for item in report.get("questions") or []:
        lines.append("")
        lines.append(f"question: {item['question']}")
        lines.append(f"passed: {item['passed']} citation: {item.get('citation')}")
        if item.get("error"):
            lines.append(f"error: {item['error']}")
        excerpt = (item.get("answer") or "").strip().replace("\n", " ")
        if excerpt:
            lines.append(excerpt[:500])
    lines.append("")
    return "\n".join(lines)


def as_list(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "items", "knowledge", "models"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


if __name__ == "__main__":
    main()
