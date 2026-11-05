"""Tests for the oikb Ops Assistant context budget. Standard library only."""

import asyncio
import copy
import unittest

from bootstrap.context_budget import (
    BUDGET_TOKENS,
    FILTER_ID,
    STUB_MARK,
    TOO_LONG_NOTE,
    budget_tokens,
    estimate_tokens,
    filter_source,
    fit_request,
)


def _user(text: str) -> dict:
    return {"role": "user", "content": text}


def _assistant(text: str, tool_calls=None) -> dict:
    message = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _call(call_id: str, arguments: str) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": "get_file_contents", "arguments": arguments},
    }


def _tool(call_id: str, text: str) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": text}


class ContextBudgetTest(unittest.TestCase):
    def test_short_chat_is_unchanged(self):
        messages = [
            {"role": "system", "content": "You are the oikb Ops Assistant."},
            _user("Where are the commands?"),
            _assistant("They are in src/cli.py."),
            _user("And the webhook?"),
            _assistant("See webhook.py."),
        ]
        original = copy.deepcopy(messages)
        self.assertEqual(fit_request(messages), messages)
        self.assertEqual(messages, original)

    def test_long_chat_keeps_relevant_history_and_drops_the_rest(self):
        messages = [
            {"role": "system", "content": "You are the oikb Ops Assistant."},
            _user("The commands live in src/cli.py."),
            _assistant("Noted, src/cli.py."),
            _user("The weather was fine."),
            _assistant("Okay."),
            _user("Issue #482 was a sync failure."),
            _assistant("Recorded #482."),
            _user("filler one"),
            _assistant("ack"),
            _user("filler two"),
            _assistant("ack"),
            _user("filler three"),
            _assistant("ack"),
            _user("Where is src/cli.py, and what happened in #482?"),
        ]
        original = copy.deepcopy(messages)
        fitted = fit_request(messages)

        self.assertEqual(messages, original)
        text = "\n".join(message["content"] for message in fitted)
        self.assertIn("You are the oikb Ops Assistant.", text)
        self.assertIn("The commands live in src/cli.py.", text)
        self.assertIn("Issue #482 was a sync failure.", text)
        self.assertIn("Where is src/cli.py", text)
        self.assertIn("filler one", text)
        self.assertNotIn("The weather was fine.", text)
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)

    def test_recent_turns_stay_and_an_older_irrelevant_turn_goes(self):
        messages = [_user(f"turn {index}") for index in range(6)]
        fitted = fit_request(messages)
        text = [message["content"] for message in fitted]
        self.assertEqual(text, ["turn 2", "turn 3", "turn 4", "turn 5"])

    def test_oversized_tool_result_becomes_a_pointer(self):
        huge = "src/big.py\n" + ("x" * (BUDGET_TOKENS * 4))
        messages = [
            {"role": "system", "content": "You are the oikb Ops Assistant."},
            _user("Read src/big.py"),
            _assistant("", [_call("call_9", '{"path":"src/big.py"}')]),
            _tool("call_9", huge),
        ]
        original = copy.deepcopy(messages)
        fitted = fit_request(messages)
        self.assertEqual(messages, original)
        self.assertEqual(fitted[1]["content"], "Read src/big.py")
        stub = fitted[3]["content"]
        self.assertIn("src/big.py", stub)
        self.assertIn(STUB_MARK, stub)
        self.assertIn("Do not call get_file_contents with the same arguments again.", stub)
        self.assertNotIn("xxxx", stub)
        self.assertEqual(fitted[2]["tool_calls"][0]["id"], "call_9")
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)
        self.assertEqual(fit_request(fitted), fitted)

    def test_passage_stays_whole_while_history_is_removed(self):
        passage = "PASSAGE-" + ("knowledge " * 400)
        messages = [_user(f"unrelated remark {index}") for index in range(12)]
        messages.append(_user(f"How does sync work?\n<source>{passage}</source>"))
        fitted = fit_request(messages)
        current = fitted[-1]["content"]
        self.assertIn(passage, current)
        self.assertNotIn("unrelated remark 0", "\n".join(message["content"] for message in fitted))
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)

    def test_relevant_tool_pair_stays_together(self):
        messages = [
            _user("Look at src/cli.py"),
            _assistant("", [_call("call_1", '{"path":"src/cli.py"}')]),
            _tool("call_1", "commands are defined in src/cli.py"),
        ]
        messages.extend(_user(f"filler {index}") for index in range(4))
        messages.append(_user("Where are the commands in src/cli.py?"))
        fitted = fit_request(messages)
        tool = next(message for message in fitted if message["role"] == "tool")
        assistant = next(message for message in fitted if message.get("tool_calls"))
        self.assertEqual(tool["content"], "commands are defined in src/cli.py")
        self.assertEqual(assistant["tool_calls"][0]["id"], "call_1")
        self.assertNotIn("filler 0", "\n".join(message.get("content") or "" for message in fitted))

    def test_orphan_tool_result_is_removed(self):
        messages = [
            _tool("call_missing", "leftover result"),
            *[_user(f"turn {index}") for index in range(5)],
        ]
        fitted = fit_request(messages)
        self.assertTrue(all(message.get("role") != "tool" for message in fitted))

    def test_oldest_relevant_turns_yield_until_the_request_fits(self):
        huge = "src/cli.py " + ("word " * 30000)
        messages = [_user(f"{huge} copy {index}") for index in range(4)]
        messages.extend(_user(f"recent {index}") for index in range(3))
        messages.append(_user("Where is src/cli.py?"))
        fitted = fit_request(messages)
        text = "\n".join(message["content"] for message in fitted)
        self.assertIn("Where is src/cli.py?", text)
        self.assertNotIn("copy 0", text)
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)

    def test_a_huge_question_becomes_a_short_note(self):
        huge = "y" * (BUDGET_TOKENS * 4)
        messages = [{"role": "system", "content": "system stays"}, _user(huge)]
        original = copy.deepcopy(messages)
        fitted = fit_request(messages)
        self.assertEqual(messages, original)
        self.assertEqual(fitted[0]["content"], "system stays")
        self.assertEqual(fitted[1]["content"], TOO_LONG_NOTE)
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)
        self.assertEqual(fit_request(fitted), fitted)

    def test_retrieved_passages_come_off_an_oversized_question(self):
        question = "Where is the sync command?"
        huge = f'<source id="1">{"x" * (BUDGET_TOKENS * 4)}</source>\n{question}'
        messages = [_user(huge)]
        original = copy.deepcopy(messages)
        fitted = fit_request(messages)
        self.assertEqual(messages, original)
        self.assertEqual(fitted[0]["content"], question)
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)

    def test_running_twice_is_stable(self):
        messages = [
            {"role": "system", "content": "system"},
            _user("see src/cli.py"),
            *[_user(f"pad {index}") for index in range(5)],
            _user("where is src/cli.py?"),
        ]
        once = fit_request(messages)
        self.assertEqual(fit_request(once), once)

    def test_filter_script_uses_the_same_logic(self):
        source = filter_source()
        self.assertNotIn("def filter_source(", source)
        self.assertIn("class Filter:", source)
        namespace = {}
        exec(source, namespace)
        body = {"messages": [_user("hello")], "tools": [{"type": "function"}]}
        original = copy.deepcopy(body)
        result = asyncio.run(namespace["Filter"]().request(body))
        self.assertEqual(result["messages"], [_user("hello")])
        self.assertEqual(body["tools"], original["tools"])
        self.assertEqual(FILTER_ID, "oikb_context_budget")

    def test_connector_id_keeps_a_turn_and_the_word_github_does_not(self):
        messages = [
            _user("The source is github:open-webui/oikb."),
            _user("We talked about github yesterday."),
            _user("filler one"),
            _user("filler two"),
            _user("filler three"),
            _user("What does github:open-webui/oikb sync?"),
        ]
        text = "\n".join(message["content"] for message in fit_request(messages))
        self.assertIn("The source is github:open-webui/oikb.", text)
        self.assertNotIn("yesterday", text)

    def test_commit_ids_ignore_a_short_unlabeled_hex_string(self):
        full = "a5c3785ed8d6a35868bc169f07e40e889087fd2e"
        messages = [
            _user("See commit abc1234 for the note."),
            _user("The value deadbee appears in the file."),
            _user("Shipped cafebabe1234."),
            _user(f"Released {full}."),
            _user("See https://github.com/open-webui/oikb/commit/abc9999"),
            _user("filler one"),
            _user("filler two"),
            _user("filler three"),
            _user(
                "What changed in commit abc1234, "
                f"{full}, and https://github.com/open-webui/oikb/commit/abc9999?"
            ),
        ]
        text = "\n".join(message["content"] for message in fit_request(messages))
        self.assertIn("See commit abc1234", text)
        self.assertIn(full, text)
        self.assertIn("commit/abc9999", text)
        self.assertNotIn("deadbee", text)
        self.assertNotIn("cafebabe1234", text)

    def test_recent_exchanges_yield_when_the_window_itself_is_too_large(self):
        block = "y" * 120_000
        messages = [
            _user("older-a " + block),
            _user("older-b " + block),
            _user("older-c " + block),
            _user("current question stays"),
        ]
        fitted = fit_request(messages)
        text = "\n".join(message["content"] for message in fitted)
        self.assertIn("current question stays", text)
        self.assertIn("older-b", text)
        self.assertIn("older-c", text)
        self.assertNotIn("older-a", text)
        self.assertLessEqual(estimate_tokens(fitted), BUDGET_TOKENS)
        self.assertEqual(fit_request(fitted), fitted)

    def test_cap_follows_the_selected_model(self):
        self.assertEqual(budget_tokens("gpt-4o-mini"), 80_000)
        self.assertEqual(budget_tokens("gpt-4o-mini-2024-07-18"), 80_000)
        self.assertEqual(budget_tokens("gpt-5-mini"), 170_000)
        self.assertEqual(budget_tokens("GPT-5-mini-2025-08-07"), 170_000)
        self.assertEqual(budget_tokens("gpt-4.1-mini"), 650_000)
        self.assertEqual(budget_tokens("gpt-4.1-mini-2025-04-14"), 650_000)
        self.assertEqual(budget_tokens("gpt-4.1-miniextra"), BUDGET_TOKENS)
        self.assertEqual(budget_tokens("oikb-ops-assistant"), BUDGET_TOKENS)

        wide = "y" * (BUDGET_TOKENS * 4)
        messages = [{"role": "system", "content": "system stays"}, _user(wide)]
        self.assertEqual(fit_request(messages)[1]["content"], TOO_LONG_NOTE)
        kept = fit_request(messages, budget=170_000)
        self.assertEqual(kept[1]["content"], wide)
        self.assertLessEqual(estimate_tokens(kept), 170_000)

        namespace = {}
        exec(filter_source(), namespace)
        body = {
            "model": "oikb-ops-assistant",
            "messages": copy.deepcopy(messages),
        }
        model = {
            "id": "oikb-ops-assistant",
            "info": {"base_model_id": "gpt-5-mini-2025-08-07"},
        }
        result = asyncio.run(namespace["Filter"]().request(body, __model__=model))
        self.assertEqual(result["messages"][1]["content"], wide)
        self.assertIn("__model__", filter_source())

    def test_filter_failure_keeps_the_system_prompt_and_current_question(self):
        namespace = {}
        exec(filter_source(), namespace)
        tools = [{"type": "function", "function": {"name": "get_file_contents"}}]
        body = {
            "messages": [
                {"role": "system", "content": "system stays"},
                _user("older turn"),
                "bad",
                _user("current question stays"),
            ],
            "tools": tools,
        }
        result = asyncio.run(namespace["Filter"]().request(body))
        self.assertEqual(
            [message["content"] for message in result["messages"]],
            ["system stays", "current question stays"],
        )
        self.assertEqual(result["tools"], tools)


if __name__ == "__main__":
    unittest.main()
