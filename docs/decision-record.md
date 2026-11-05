# Decision record

Four decisions, in the order the task asks for them. Each one has the options, the choice, the trade-off, and what would change it. The longer write-up of the same decision is the ADR with the same number.

## 1. Freshness

How fresh is fresh enough? What triggers the sync, and where does it run?

Options: a webhook on every push, a one-shot container on a schedule, oikb-daemon at `interval: 15m`.

Choice: 15 minutes is fresh enough. oikb-daemon's own schedule triggers the sync. It runs as its own Fargate task, not inside the website. Bootstrap runs one sync during setup. oikb-daemon starts only after that setup exits 0, then repeats every 15 minutes.

Trade-off: the library can lag `main` by 15 minutes. A webhook would be fresher, but GitHub only sends one to an admin of the repository, and this project does not administer `open-webui/oikb`. Re-checking an unchanged public repository is cheap.

Change this if the library must be current within a minute of a push. See [ADR 0001](adr/0001-freshness.md).

## 2. Access scope

Which credentials and permissions does the github-mcp connection get, and how do you meet the security requirement?

Options: GitHub's hosted MCP endpoint with the token in the website, a private github-mcp task with a token that can write, a private task started with `http --read-only` plus a read-only token.

Choice: a private Fargate task, `ghcr.io/github/github-mcp-server:v2.0.3`, command `http --read-only`. The token can read Contents, Issues, and Pull requests, and nothing else. github-mcp does not read that token from the environment, so github-mcp-proxy on the task adds it. Bootstrap stops if a write tool is listed. The website task does not receive the token. Bootstrap and oikb-daemon receive the same read-only token so the public sync is not stopped by the anonymous rate limit.

Trade-off: an extra pinned service, so write tools are absent from the process and the token is not in the website. The hosted endpoint would be less to run. The token and the process flag both have to stay read-only.

Change this if the source repository becomes private, or if a hosted read-only endpoint becomes the supported path and can keep the token out of Open WebUI. See [ADR 0002](adr/0002-access-scope.md).

## 3. Failure detection

How does the admin learn the sync is broken before the support team notices?

Options: someone watches the logs or the dashboard, an email when a sync reports an error, an alarm when a successful sync has not been seen.

Choice: on error oikb-daemon POSTs to a signer on `127.0.0.1:8089` in the same task. That signer calls a Lambda, which emails via SNS. If bootstrap fails, a separate email goes out and oikb-daemon stays off, so a sync that never starts is visible. If `GET /health` says a sync has been `running` for more than an hour, an alarm sends the same kind of note. If the daemon task is up and stops reporting that page, another alarm does too. The dashboard shows the latest sync, the totals since the task started, and a history of finished syncs. The SNS email subscription has to be confirmed once.

Trade-off: email covers a reported error, a setup that never starts oikb-daemon, a sync that stays `running` past an hour, and a daemon task that is up but has stopped reporting. The hour is a limit. A download still inside that hour does not page anyone. An unconfirmed email subscription drops the mail.

Change this if an hour of `running` is too long. See [ADR 0003](adr/0003-failure-detection.md).

## 4. Scope

Something will not fit into the time available. What do you leave out, and why that?

Options: drop HTTPS, a second website task, Redis, Tika, a private copy of the images in ECR, a push webhook, a grader that keeps running, or RDS Proxy.

Choice: leave out the second website task, Redis, Tika, the ECR copy, the webhook, the standing grader, and RDS Proxy. Keep HTTPS, the 15-minute oikb-daemon, read-only github-mcp, PostgreSQL, and the failure email. A long chat stays complete on screen. The assistant filter keeps the model request inside the window. See [ADR 0004](adr/0004-scope.md).

Trade-off: those seven are extra machinery. The review needs a URL, a current library, read-only GitHub, sessions that survive a new task, and a failure email. Cutting one of those five would miss the task. Cutting the seven does not.

Change this when one of those gaps is no longer acceptable. How to add each one is in [ADR 0004](adr/0004-scope.md).
