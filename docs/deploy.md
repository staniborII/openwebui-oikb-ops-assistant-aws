# Deploy the demo

Deploy the five stacks, confirm the SNS email, and wait for the ready message. The assistant is not ready when the CDK command returns.

## Before the first deploy

1. Put `OPENAI_API_KEY`, `GITHUB_TOKEN`, `WEBUI_ADMIN_EMAIL`, `WEBUI_ADMIN_PASSWORD`, `SLACK_WEBHOOK_URL`, `ENABLE_SIGNUP`, and `DEFAULT_USER_ROLE` in `infra/.env`. Do not commit that file. `GITHUB_TOKEN` is a fine-grained token with Contents, Issues, and Pull requests set to Read. `SLACK_WEBHOOK_URL` is the Slack incoming webhook for the alerts channel. `ENABLE_SIGNUP=true` and `DEFAULT_USER_ROLE=user` let other people create an account and use it immediately.
2. In `infra/config.dev.yaml`, set `WEB_DOMAIN_NAME`, `DOMAIN_HOSTED_ZONE_ID`, and `DOMAIN_HOSTED_ZONE_NAME` for the flexxytech.com zone, a certificate ARN in `us-east-1` that covers that name, and a real `SNS_EMAIL`. Confirm that certificate before a real deploy. `ALLOWED_IPS` is `0.0.0.0/0` until you replace it.
3. Start Docker. The bootstrap, oikb, notify-proxy, github-mcp-proxy, and sync-metrics images are built during deploy.
4. Bootstrap the account once if this account and region have never run CDK: `npx cdk bootstrap aws://<account>/us-east-1` from `infra/`.

Run `npx cdk synth` from `infra/` after any change under `infra/`, `bootstrap/`, or `containers/`. Synth reads those values from the environment, using `infra/.env` when they are not already set. Deploy only after that synth succeeds.

## Deploy

From `infra/`:

```text
npx cdk deploy --all
```

The stack reads `OPENAI_API_KEY`, `GITHUB_TOKEN`, `WEBUI_ADMIN_EMAIL`, and `WEBUI_ADMIN_PASSWORD` from the environment and passes them to the tasks that need them. `ENABLE_SIGNUP` and `DEFAULT_USER_ROLE` are passed to Open WebUI as plain settings. `SLACK_WEBHOOK_URL` is stored for the Slack Lambda. The default stage is `dev` (`infra/cdk.json`).

For prod:

```text
npx cdk deploy --all -c stage=prod
```

The stacks deploy in order: Network, Data, App, Orchestration, Monitoring.

## After the command returns

1. Confirm the SNS subscription email. Until that confirmation, the ready mail, the setup failure mail, and the health alarms do not arrive. This click cannot be done in code. Slack posts those same notes as soon as the deploy finishes. The monthly budget mail stays email only.
2. Confirm the separate AWS Budgets email. In Billing, activate the `Service` cost allocation tag once. Until that tag is active, the monthly budget email sees no spend.
3. Wait for the ready email. It contains the site URL. It does not contain the admin password. Sign in with `WEBUI_ADMIN_EMAIL` and `WEBUI_ADMIN_PASSWORD` from `.env`.
4. Open the CloudWatch dashboard named in the monitoring stack output. Health alarms arrive as short sentences: what is wrong, the stage, and the time. A later mail says the same thing has recovered.
5. If a failure email arrives, read the stage, the reason, and the log group it names. oikb-daemon stays off. A setup failure can also send a short alarm that points at that email.

The workflow creates the vector extension, migrates Open WebUI, starts one website task, waits 30 seconds, runs bootstrap, starts oikb-daemon, then sends the ready mail. Bootstrap polls `/health/db` for up to 20 minutes. Bootstrap writes the report to `reports/<stage>/<stamp>.json` in the stage bucket. `reports/<stage>/latest.json` names that object. How to read it is in the [eval proposal](eval-proposal.md).

The setup workflow starts the vector, migrate, and bootstrap tasks by family name. A new image updates the app stack and does not start the workflow by itself. After that deploy, start the state machine `chapters-bootstrap-<stage>` once. Bootstrap reuses the same knowledge base and assistant.

v0.13.0 changes the database schema. Stop the website service before deploying the new image, so the running task is not replaced before Alembic runs. Then start `chapters-bootstrap-<stage>`. The migrate step imports `open_webui.config` with migrations on and upgrades to head. The website task keeps migrations off and starts only after that step. Take a database snapshot before the prod run.

The first deploy of this family-name change must update Orchestration before App. The live orchestration stack still imports the old task-definition export, and a normal deploy updates App first. `--exclusively` updates Orchestration alone. From `infra/`:

```bash
npx cdk deploy ChaptersOrchestrationDev -c stage=dev --exclusively
npx cdk deploy ChaptersAppDev -c stage=dev
```

The orchestration update starts one setup run against the image that is already live. That run can fail. Start `chapters-bootstrap-dev` again after the app stack update. Later deploys can use `cdk deploy --all` again.
