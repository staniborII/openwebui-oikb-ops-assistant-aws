# Eval proposal

A support person should be able to trust the answer. That means it names something that really exists in the oikb repository or on GitHub, and it looked in the place that question needs. The knowledge base is the saved copy of the repository. github-mcp is the live look at issues and recent changes. A fluent answer that used the wrong one is still a miss.

This page is that check. Bootstrap runs it once, when the site is first set up, and writes a report to the stage bucket. A service that sits in the background and grades every later chat is out of scope.

## Questions

Bootstrap asks six questions. The first three run against the copy that was just synced:

1. Where in the code are the oikb commands defined?
2. Where in the code are GitHub webhooks processed?
3. Which connectors does oikb currently provide?

The first two should point at a file. The third should name a connector.

The last three need a live look at GitHub:

4. A customer's Google Drive sync re-uploads a file on every run when the filename contains a slash. Is that a known issue on open-webui/oikb? Look up the open issues and cite the number.
5. What landed on main of open-webui/oikb in the latest commits? Name the commit shas and what each merge changed. Use GitHub, and cite the shas.
6. Which open pull requests on open-webui/oikb change sync behavior or ignore rules? Cite the numbers and titles.

The fourth should cite an issue number. The fifth should cite commit shas. The sixth should cite pull request numbers. An answer that only retells the knowledge base fails that question.

## How a run is scored

Bootstrap sends each question to `POST /api/chat/completions` as `oikb Ops Assistant`. Streaming is off. The github-mcp tool id is attached on the last three questions. The first three are about the synced copy, and those requests do not attach the tool. For each question the report keeps the question, the answer text, whether Open WebUI returned a source citation, pass or fail, and a one-sentence reason for that result. The reason names the file, connector, issue, pull request, or commit that decided a pass, or the check that was missing.

A pass on a library question needs a citation. The commands and webhook questions also need a path-like file in the answer. The connectors question needs one name from the guide's list of 47, matched as a whole word. A route, a function, or a source id does not count. A path that appears only as an example, or in a sentence that offers to search, does not count.

A pass on a live question needs an issue number (`#123` or `issues/123`), a pull-request number written the same way, or a commit sha of 12 to 40 hex characters in the answer. The citation flag is still stored. A live answer can pass without one.

The automatic check can see that the answer looks like a file path, an issue number, or a commit sha. It cannot open the repository and prove the name is real. That is left to a person.

A weak or empty answer is saved, and the deploy still succeeds. A broken setup does not. If health, sign-in, github-mcp registration, the tool list, or file processing fails, the task fails, the failure email goes out, and oikb-daemon stays off. A write tool in the list is one of those setup failures. The report keeps the two outcomes apart: `infrastructure_ok` is the setup, and `evaluation_ok` is the six answers.

The current report lands in the stage bucket as two objects:

- `reports/<stage>/latest.json`, the full answers
- `reports/<stage>/latest.txt`, a short summary of those answers

When a later run replaces `latest.json`, the previous report is kept as `reports/<stage>/<stamp>.json`. The date is when that older report was saved. The new run is not also stored under a date.

## What a person still does

Read `latest.json` before sending anyone the URL. Check that the library answers cite real files, or a real list of connectors (e.g. Github, Gitlab, Confluence etc. Should  be one of the 47 connectors), and that the live answers name a real issue, commit, or pull request. A number the model invented still fails that reading. In the browser, the tool trace for a live question should be a read of issues, commits, or pull requests, and no write tool should have been offered.

A grader that keeps running is not in this repository yet. The shape of it is already clear. EventBridge would start a task on a schedule. That task would ask the same six questions bootstrap already asks and write another object under `reports/<stage>/`. The expected path fragments would be pinned from a known-good `latest.json`, so a later run can be compared with one that was already trusted. The live questions are scored by an issue number, a pull-request number, or a commit sha of 12 to 40 hex characters in the answer. A small set of answers from release `v0.6.0` would sit beside them, so a change in the model is visible. Take that set from a run against the deployed assistant, not from memory. A weak answer would update the report and leave oikb-daemon running.
