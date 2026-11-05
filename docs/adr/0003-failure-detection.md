# ADR 0003: Failure detection

Status: accepted.

## Context

Support should not be the first to notice that the knowledge-base copy stopped updating. The admin asked to hear about a broken sync.

## Options

1. Someone watches the oikb-daemon logs, or the dashboard, and notices on their own.
2. An email/notification goes out when a sync reports an error.
3. An alarm fires when a successful sync has not been seen for longer than the interval.

## Decision (option 2)

The admin gets an email/notification when a sync reports an error, and a different email/notification when setup fails and oikb-daemon never starts.

oikb-daemon reports the error itself. `containers/oikb/.oikb.yaml` sets `notify.on: error`. The official image can only send a plain POST, so `NOTIFY_URL` is `http://127.0.0.1:8089` inside the same task. `containers/notify-proxy` signs that POST and calls the Lambda function URL. The URL requires IAM, and only the oikb-daemon task role may invoke it. Port 8089 is not published on the task. The function publishes to an SNS topic. The ready mail and the setup-failure mail use that same topic. The function lives in the App stack because the oikb-daemon task needs the URL. Putting it in Orchestration would make the two stacks depend on each other.

If bootstrap fails, the failure email goes out and oikb-daemon stays at zero tasks. A sync that never starts is a different message from a sync that ran and failed.

The dashboard shows the current sync and the totals since the task started. `containers/sync-metrics` reads `GET /metrics` and `GET /health` once a minute and publishes those numbers to CloudWatch namespace `Chapters/Oikb`, including the first reading. The totals do not send mail. A history line is written to the daemon log group when a sync finishes, and the dashboard table shows that line.

The same program reads `GET /health`. oikb sets a source to `running` and records `started_at` when a sync begins, and leaves it there until the sync returns. If that time is an hour old or more, the program publishes `SyncRunningTooLong`. An alarm on that value emails the admin and posts the same note to Slack. The subject is `Action needed: <stage> sync hung`. When the sync ends, a recovered note follows. A sync that is still `running` inside the hour does not page anyone. Each successful read also publishes `SyncReport`. If the daemon task is live and that reading is missing for five minutes, a separate alarm sends `Action needed: <stage> sync status`. A quiet stretch between syncs still publishes the reading, so the 15 minutes after a sync is not a page.

SNS still needs one person to confirm the subscription. Until that click, neither the ready mail nor the failure mail arrives. Slack does not need that click.

## Trade-off

Email covers a sync that says it failed, a setup that never starts oikb-daemon, a sync that stays `running` for more than an hour, and a daemon task that is up but has stopped reporting. The hour is a limit, not proof the download has stopped. A normal sync of this repository finishes inside it. An unconfirmed email subscription still drops the mail. The Slack post uses the same topic.

## What would change this

Shorten the hour if an hour of `running` is too long. Do not alarm on a missing successful sync. That counter stays still for the whole of a healthy long download, and the 15 minutes after it ends is the normal gap.
