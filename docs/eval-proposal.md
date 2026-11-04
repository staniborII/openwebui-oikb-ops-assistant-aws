# Eval proposal

A support person should be able to trust the answer. That means it names something that really exists in the oikb repository or on GitHub, and it looked in the place that question needs. The knowledge base is the saved copy of the repository. The MCP server is the live look at issues and recent changes. A fluent answer that used the wrong one is still a miss.

This page is that check. Bootstrap runs it once, when the site is first set up, and writes a report to the stage bucket. A service that sits in the background and grades every later chat is out of scope.

## Questions

Bootstrap asks three questions against the copy that was just synced:

1. Where in the code are the oikb commands defined?
2. Where in the code are GitHub webhooks processed?
3. Which connectors does oikb currently provide?

The first two should point at a file. The third should name a connector. After the ready email, a person asks one more question in the browser, about a known issue or a recent commit. A good answer comes from the GitHub tool. Saying the tool was consulted and nothing relevant came back is also fine. An answer that only retells the knowledge base, with no live lookup, fails that question.

## How a run is scored

Bootstrap sends each of the three questions to `POST /api/chat/completions` as `oikb Ops Assistant`. Streaming is off, and the MCP tool id is attached, so the assistant can call GitHub if it chooses. For each question the report keeps the question, the answer text, whether Open WebUI returned a source citation, and pass or fail.

A pass needs both of these:

- A citation is present.
- The answer names a path-like file from the synced repository. For the connectors question, it names a connector.

The automatic check is deliberately shallow. It can see that the answer looks like a file path. It cannot open the repository and prove the file is real. That is left to a person.

A weak or empty answer is saved, and the deploy still succeeds. A broken setup does not. If health, sign-in, MCP registration, the tool list, or file processing fails, the task fails, the failure email goes out, and the daemon stays off. A write tool in the list is one of those setup failures. The report keeps the two outcomes apart: `infrastructure_ok` is the setup, and `evaluation_ok` is the three answers.

The report lands in the stage bucket as three objects:

- `reports/<stage>/latest.json`
- `reports/<stage>/latest.txt`
- a timestamped JSON object beside them

## What a person still does

Read `latest.json` before sending anyone the URL. Check that the three answers cite real files, or a real list of connectors, and not a plausible path the model invented. Then ask the live GitHub question in the browser. The tool trace should be a read of issues, commits, or file contents, and no write tool should have been offered.

A grader that keeps running is not in this repository yet. The shape of it is already clear. EventBridge would start a task on a schedule. That task would ask the same three questions bootstrap already asks and write another object under `reports/<stage>/`. The expected path fragments would be pinned from a known-good `latest.json`, so a later run can be compared with one that was already trusted. The live question would be scored by whether a tool call happened. A small set of answers from release `v0.6.0` would sit beside them, so a change in the model is visible. Take that set from a run against the deployed assistant, not from memory. A weak answer would update the report and leave the daemon running.
