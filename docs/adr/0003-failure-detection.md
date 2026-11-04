# ADR 0003: Failure detection

Status: accepted.

## Context

Support should not be the first to notice that the knowledge-base copy stopped updating. The admin asked to hear about a broken sync.

## Options

Someone watches the daemon logs, or the dashboard, and notices on their own.

An email goes out when a sync reports an error.

An alarm fires when a successful sync has not been seen for longer than the interval.

## Decision

The admin gets an email when a sync reports an error, and a different email when setup fails and the daemon never starts.

The daemon reports the error itself. `containers/oikb/.oikb.yaml` sets `notify.on: error`. The official image can only send a plain POST, so `NOTIFY_URL` is `http://127.0.0.1:8089` inside the same task. `containers/notify-proxy` signs that POST and calls the Lambda function URL. The URL requires IAM, and only the daemon task role may invoke it. Port 8089 is not published on the task. The function publishes to an SNS topic. The ready mail and the setup-failure mail use that same topic. The function lives in the App stack because the daemon task needs the URL. Putting it in Orchestration would make the two stacks depend on each other.

If bootstrap fails, the failure email goes out and the daemon stays at zero tasks. A sync that never starts is a different message from a sync that ran and failed.

The dashboard shows syncs that finished. `containers/sync-metrics` reads `GET /metrics` once a minute and publishes sync counts, file counts, and duration to CloudWatch namespace `Chapters/Oikb`. The first page is only a baseline. Those graphs do not send mail.

SNS still needs one person to confirm the subscription. Until that click, neither the ready mail nor the failure mail arrives.

## Trade-off

Email covers a sync that says it failed, and the workflow covers a setup that never starts the daemon. A sync that hangs without reporting an error does not page anyone. An unconfirmed subscription has the same result. That gap is accepted for this demo.

## What would change this

Add an alarm when a successful sync has not been seen for longer than the interval, if a silent stall is no longer acceptable. The email path already covers a sync that reports an error.
