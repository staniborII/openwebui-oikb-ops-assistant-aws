"""Score one evaluation answer. Pure checks, no network."""

from __future__ import annotations

import re

PATH_RE = re.compile(r"[\w./-]+\.(?:py|md|yml|yaml|toml|json|go|rs|ts|js)")
# Names from the oikb guide's All Connectors table. One match is enough.
CONNECTORS = (
    "github",
    "gitlab",
    "gitea",
    "bitbucket",
    "s3",
    "gcs",
    "azure blob",
    "dropbox",
    "r2",
    "google drive",
    "sharepoint",
    "nextcloud",
    "egnyte",
    "oracle cloud",
    "confluence",
    "notion",
    "bookstack",
    "discourse",
    "gitbook",
    "guru",
    "outline",
    "slab",
    "document360",
    "dokuwiki",
    "google sites",
    "jira",
    "linear",
    "zendesk",
    "freshdesk",
    "asana",
    "clickup",
    "airtable",
    "servicenow",
    "productboard",
    "slack",
    "discord",
    "microsoft teams",
    "gmail",
    "zulip",
    "gong",
    "fireflies",
    "xenforo",
    "salesforce",
    "hubspot",
    "website",
    "sitemap",
    "zotero",
)
CONNECTOR_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(name) for name in sorted(CONNECTORS, key=len, reverse=True)) + r")\b",
    re.I,
)
GITHUB_RE = re.compile(r"#\d+|\bissues?/\d+\b|\b[0-9a-f]{12,40}\b", re.I)
_OFFER_RE = re.compile(
    r"\b(?:shall I|should I|I can search|let me search|want me to)\b",
    re.I,
)
_EXAMPLE_PARENS_RE = re.compile(
    r"\((?:e\.g\.|for example|such as)\b[^)]*\)",
    re.I,
)
_EXAMPLE_CLAUSE_RE = re.compile(
    r"(?:e\.g\.|for example|such as)\b[^.\n]*",
    re.I,
)


def answer_is_specific(index: int, answer: str, live: bool) -> bool:
    """Return whether this answer names the thing that question requires."""
    if live:
        return bool(GITHUB_RE.search(answer))
    if index == 2:
        return bool(CONNECTOR_RE.search(answer))
    return bool(PATH_RE.search(asserted_answer(answer)))


def score_answer(index: int, answer: str, live: bool, cited: bool) -> tuple[bool, str]:
    """Return pass or fail, and one sentence that says why.

    A pass is the same check as before: the answer names what that question
    requires, and a library answer also has a citation.
    """
    text = answer.strip()
    if not text:
        return False, "The answer was empty."
    if live:
        return _score_live(text)
    if index == 2:
        return _score_connector(text, cited)
    return _score_file(text, cited)


def _score_live(text: str) -> tuple[bool, str]:
    found = GITHUB_RE.search(text)
    if not found:
        return False, "The answer does not cite an issue number, a pull request number, or a commit sha."
    token = found.group(0)
    if re.fullmatch(r"[0-9a-f]{12,40}", token, re.I):
        kind = "a commit sha"
    else:
        kind = "an issue or pull request number"
    return True, f"The answer cites {kind} ({token})."


def _score_connector(text: str, cited: bool) -> tuple[bool, str]:
    found = CONNECTOR_RE.search(text)
    if found and cited:
        return True, f"The answer has a citation and names a connector ({found.group(0)})."
    if found:
        return False, f"The answer names a connector ({found.group(0)}) but has no citation."
    if cited:
        return False, "The answer has a citation but does not name a connector."
    return False, "The answer has no citation and does not name a connector."


def _score_file(text: str, cited: bool) -> tuple[bool, str]:
    stated = PATH_RE.search(asserted_answer(text))
    if stated and cited:
        return True, f"The answer has a citation and names a file ({stated.group(0)})."
    if stated:
        return False, f"The answer names a file ({stated.group(0)}) but has no citation."
    if PATH_RE.search(text):
        if cited:
            return False, "The answer has a citation, but the only file path is an example or an offer to search."
        return False, "The answer has no citation, and the only file path is an example or an offer to search."
    if cited:
        return False, "The answer has a citation but does not name a file."
    return False, "The answer has no citation and does not name a file."


def asserted_answer(answer: str) -> str:
    """Drop an offer to search, and a path that is only an example."""
    kept = []
    for part in re.split(r"(?<=[.!?])\s+|\n+", answer):
        if _OFFER_RE.search(part):
            continue
        cleaned = _EXAMPLE_PARENS_RE.sub(" ", part)
        kept.append(_EXAMPLE_CLAUSE_RE.sub(" ", cleaned))
    return " ".join(kept)
