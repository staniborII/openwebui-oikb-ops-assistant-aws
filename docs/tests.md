# Tests

These files check the code on a laptop. They do not call AWS, Open WebUI, or GitHub. The six questions bootstrap asks of the running assistant are a different check, written in the [eval proposal](eval-proposal.md).

## Run them

Context budget, from the repository root:

```text
python -m unittest bootstrap.context_budget_test
```

Sync readings, from `containers/sync-metrics`:

```text
node --test readings.test.js
```

Infrastructure, from `infra/`:

```text
npm test
```

`npm test` runs the notify handler, the Slack handler, and the CDK template checks together.

## Context budget

`bootstrap/context_budget_test.py` checks `fit_request` in `bootstrap/context_budget.py`. That function builds the shorter message list sent to the model. The chat stored in Open WebUI stays complete. The default cap is 80,000 estimated tokens. `gpt-5-mini` uses 170,000. `gpt-4.1-mini` uses 650,000. Any other name uses 80,000.

A turn stays when it shares a file path, an issue number, a connector id such as `github:open-webui/oikb`, or a commit id with the current question. The word `github` by itself does not count. A hex string counts when it is labeled as a commit, appears in a `/commit/` URL, or is a 40- or 64-character sha. A short unlabeled hex string does not. The last four turns stay even when they share nothing, unless that window itself is over the cap.

| Test | What it checks |
|---|---|
| `test_short_chat_is_unchanged` | A short chat is returned as it arrived. The input list is not rewritten. |
| `test_long_chat_keeps_relevant_history_and_drops_the_rest` | The system prompt, turns that share `src/cli.py` or `#482` with the question, and a recent filler turn stay. An older turn about the weather goes. The result is under the cap. |
| `test_recent_turns_stay_and_an_older_irrelevant_turn_goes` | Six unrelated turns become the last four. |
| `test_oversized_tool_result_becomes_a_pointer` | A tool result larger than the cap becomes a short note that names the path and says not to call `get_file_contents` with the same arguments again. The file body is gone. Fitting that result a second time changes nothing. |
| `test_passage_stays_whole_while_history_is_removed` | A retrieved `<source>` passage on the current question stays whole. Older unrelated remarks go. |
| `test_relevant_tool_pair_stays_together` | A tool call and its result stay as a pair when the current question names the same path. Filler turns go. |
| `test_orphan_tool_result_is_removed` | A tool result whose call is missing is dropped. |
| `test_oldest_relevant_turns_yield_until_the_request_fits` | When several matching turns are each too large, the oldest ones go until the request fits. The current question stays. |
| `test_a_huge_question_becomes_a_short_note` | A question larger than the cap becomes "This question is too long to send." The system prompt stays. |
| `test_retrieved_passages_come_off_an_oversized_question` | When the question plus its `<source>` blocks is over the cap, the passages come off and the question text stays. |
| `test_running_twice_is_stable` | Fitting an already fitted list returns the same list. |
| `test_filter_script_uses_the_same_logic` | `filter_source()` is one script with a `Filter` class, id `oikb_context_budget`. A short request is unchanged, and the tool list is left alone. |
| `test_connector_id_keeps_a_turn_and_the_word_github_does_not` | `github:open-webui/oikb` keeps an older turn. The word `github` alone does not. |
| `test_commit_ids_ignore_a_short_unlabeled_hex_string` | A labeled short sha, a 40-character sha, and a `/commit/` URL stay. An unlabeled short hex string does not. |
| `test_recent_exchanges_yield_when_the_window_itself_is_too_large` | When the recent window is over the cap, the oldest of those turns goes. The current question stays, and a second fit changes nothing. |
| `test_cap_follows_the_selected_model` | `gpt-4o-mini` is 80,000, `gpt-5-mini` is 170,000, `gpt-4.1-mini` is 650,000, including a dated suffix. An unknown name uses 80,000. The filter reads `base_model_id` from the assistant, so a question that is too long for the default cap is kept when the base model is `gpt-5-mini`. |
| `test_filter_failure_keeps_the_system_prompt_and_current_question` | A message that is not a chat object is dropped. The system prompt, the current question, and the tool list stay. |

## Sync readings

`containers/sync-metrics/readings.test.js` checks the parsing in `readings.js`. That module turns oikb-daemon's `/metrics` and `/health` pages into the CloudWatch numbers the dashboard shows.

| Test | What it checks |
|---|---|
| `a metrics page keeps the sync series and the version` | A Prometheus page yields the six sync and info samples, including version `0.6.0`. Duration lines are left out. |
| `the first metrics page is published as totals, including a status that has not happened` | Success and error counts, files uploaded, files deleted, and sync errors become `SyncsFinished`, `FilesUploadedTotal`, `FilesDeletedTotal`, and `SyncErrorsTotal` for stage `dev`. A `partial` status that never appeared is published as 0. Every point has `Stage` and `Source`. |
| `a sync is hung only after it has been running for an hour` | `running` for 30 minutes is 0. `running` for 60 minutes is 1, published as `SyncRunningTooLong`. A successful sync, a running sync with no start time, and a health page with no sources are not hung. |
| `health becomes the numbers on the dashboard` | One source becomes `SyncReport` 1, seconds since the last sync, duration in seconds, files added, modified, and removed, and seconds until the next sync. `1h30m` is 5400 seconds. An empty duration is skipped. |
| `health becomes a status record, and a finished sync is history once` | A running source is a status record and writes no history line. The same source later finishing writes one line, with the file count and the first error. Seeing that finish again writes nothing. A health page with no sources is skipped. |

## Notify and Slack

`infra/test/notify.test.js` checks `infra/lambda/notify`. The handler publishes the sync-failure body to the SNS topic.

| Test | What it checks |
|---|---|
| `a sync failure is published with a fixed subject` | A JSON body is published as that body, subject `oikb sync failed`, on `TOPIC_ARN`. The handler returns 200. |
| `a non-string event is sent as text and long bodies are cut off` | An event without a string body is sent as JSON text. A body longer than 100,000 characters is cut to that length. The subject stays `oikb sync failed`. |

`infra/test/slack.test.js` checks `infra/lambda/slack`. The handler posts the SNS message to the Slack incoming webhook.

| Test | What it checks |
|---|---|
| `an alert is posted as the subject and the body` | The post is the subject, a blank line, and the message, sent to the webhook URL. |
| `a webhook that is not Slack is refused before any post` | A URL outside `https://hooks.slack.com/services/` raises before anything is posted. A Slack URL with no webhook id raises the same way. |
| `a failed post raises the status and a long note is cut off` | A Slack response of 400 raises `Slack returned 400`. The posted text does not contain the webhook host. A note longer than 40,000 characters is cut to that length. An empty subject and body become the word `Alert`. |

## Resource names

`infra/test/resource-names.test.ts` synthesizes Network, Data, App, and Orchestration and reads the CloudFormation templates. It uses a stand-in account and stand-in secrets. Nothing is deployed.

| Test | What it checks |
|---|---|
| `dev database, bucket, and secret identities stay fixed` | Dev keeps the database id `chapters-postgres-dev`, the files bucket `chapters-openwebui-dev`, and the access-log bucket `chapters-openwebui-dev-alb-logs`. The logical ids of those resources and of the Secrets Manager secrets stay the same, so a rename in CDK fails this test before a deploy replaces them. |
| `dev tasks and roles stay least privilege` | The migrate task receives only `DATABASE_URL`, `PGVECTOR_DB_URL`, and `WEBUI_SECRET_KEY`. The website task receives `OPENAI_API_KEY` and `WEBUI_ADMIN_PASSWORD`, and its `CORS_ALLOW_ORIGIN` matches `WEBUI_URL` and the migrate task. Secret writes are `secretsmanager:PutSecretValue`. `secretsmanager:UpdateSecret` is absent. The access-log bucket policy does not add a second statement for the load balancer log-delivery service. The orchestration role is denied `ecs:StopTask` and `ecs:DescribeTasks` unless the cluster matches, and denied `iam:PassRole` unless the service is `ecs-tasks.amazonaws.com`. |
| `prod keeps its own database and bucket names` | Prod uses `chapters-postgres-prod`, `chapters-openwebui-prod`, `chapters-openwebui-prod-alb-logs`, `chapters-oikb-notify-prod`, and `chapters-slack-prod`. |

Alarm mail, the database URL function, notify-proxy, and github-mcp-proxy have no test file. Bootstrap's setup steps are checked by a deploy. A person still reads the S3 report. See the [eval proposal](eval-proposal.md).
