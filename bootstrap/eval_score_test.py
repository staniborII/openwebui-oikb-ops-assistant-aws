"""Checks for the six evaluation answers. Standard library only."""

import unittest

from bootstrap.eval_score import CONNECTORS, answer_is_specific, score_answer


WEBHOOK_MISS = (
    "GitHub webhooks are handled by the POST /webhooks/github route, implemented "
    'as the github_webhook handler (@router.post("/github")).'
)
COMMAND_GUESS = (
    "The commands live in the CLI layer. If you want the exact source file "
    "(e.g., oikb/cli.py or __main__.py) I can search the repository — shall I run that search?"
)


class EvalScoreTest(unittest.TestCase):
    def test_webhook_route_without_a_file_fails(self):
        self.assertFalse(answer_is_specific(1, WEBHOOK_MISS, False))

    def test_guessed_example_path_fails(self):
        self.assertFalse(answer_is_specific(0, COMMAND_GUESS, False))

    def test_any_stated_file_passes(self):
        self.assertTrue(answer_is_specific(0, "The commands are in src/oikb/cli.py.", False))
        self.assertTrue(answer_is_specific(0, "File: cli.py is the commands module.", False))
        self.assertTrue(answer_is_specific(0, "The commands are in oikb/cli.py.", False))
        self.assertTrue(answer_is_specific(1, "See src/oikb/connectors/github.py.", False))

    def test_connector_name_still_passes(self):
        self.assertEqual(len(CONNECTORS), 47)
        self.assertTrue(answer_is_specific(2, "oikb provides GitHub and Confluence.", False))
        self.assertTrue(answer_is_specific(2, "Notion is one connector.", False))
        self.assertTrue(answer_is_specific(2, "It also syncs R2.", False))
        self.assertFalse(answer_is_specific(2, "It provides several connectors.", False))
        self.assertFalse(answer_is_specific(2, "The bucket is or2 storage.", False))

    def test_live_answer_still_needs_a_number_or_a_sha(self):
        self.assertTrue(answer_is_specific(3, "See issue #149.", True))
        self.assertTrue(answer_is_specific(4, "29b0e453812c landed on main.", True))
        self.assertFalse(answer_is_specific(5, "There are some open pull requests.", True))

    def test_score_names_the_reason(self):
        cases = [
            (1, "See webhooks.py.", False, True, True, "names a file (webhooks.py)"),
            (1, WEBHOOK_MISS, False, True, False, "does not name a file"),
            (0, COMMAND_GUESS, False, True, False, "example or an offer to search"),
            (0, "The commands are in cli.py.", False, False, False, "names a file (cli.py) but has no citation"),
            (2, "Notion is one connector.", False, True, True, "names a connector (Notion)"),
            (2, "It provides several connectors.", False, True, False, "does not name a connector"),
            (3, "See issue #149.", True, False, True, "an issue or pull request number (#149)"),
            (4, "29b0e453812c landed on main.", True, False, True, "a commit sha (29b0e453812c)"),
            (5, "There are some open pull requests.", True, False, False, "does not cite an issue number"),
            (4, "   ", True, False, False, "The answer was empty."),
        ]
        for index, answer, live, cited, expect_pass, fragment in cases:
            passed, reason = score_answer(index, answer, live, cited)
            self.assertEqual(passed, expect_pass)
            self.assertIn(fragment, reason)
            self.assertEqual(
                passed,
                answer_is_specific(index, answer, live) and bool(answer.strip()) and (cited or live),
            )

    def test_an_example_clause_does_not_hide_an_earlier_file(self):
        answer = "The handler is in src/oikb/webhooks.py. For example, it checks the signature."
        self.assertTrue(answer_is_specific(1, answer, False))
