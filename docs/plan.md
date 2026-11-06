# Part A implementation plan

Review this before any infrastructure code is written. It is the contract for the build.

The reading guide in `docs/part-a-guide.md` explains the case study. This file says what we will build.

## Decisions

**Region `us-east-1`.** Every stack in a deploy uses this region. Secrets Manager values that Fargate injects must also be in `us-east-1`. A secret ARN in another region cannot be mounted into these tasks.

**Stage files live in `infra/`.** `infra/config.dev.yaml` and `infra/config.prod.yaml` hold settings that are safe to commit. The stage type is `dev`, `staging`, or `prod`. CDK selects `infra/config.<stage>.yaml`. Resource ids and names go through `stagified` in `infra/utils/index.ts`. Construct ids are `NameDev`. Physical names are `name-dev`. Adding a stage means adding that yaml file, not copying a stack.

**HTTPS on the stage hostname.** Each config file sets `WEB_DOMAIN_NAME` to the full name for that stage, for example `dev-client-openwebui.flexxytech.com`. The name is one label under the hosted zone so the `*.flexxytech.com` certificate covers it. It also sets the FlexxyDrive hosted zone id and name, and the ACM certificate ARN. CDK creates an alias record in that zone. Port 80 redirects to 443. `WEBUI_URL` is `https://` plus `WEB_DOMAIN_NAME`.

The certificate must be the `us-east-1` certificate, and it must cover that hostname. The hosted zone is in the same AWS account as the deploy. `ALLOWED_IPS` in the config file is the only client range that can open the load balancer.

**Five stacks, one direction.** Network, then Data, then App, then Orchestration, then Monitoring. A stack may use outputs from stacks before it. It never imports a stack that depends on it. Data does not know the website exists. The App stack opens port 5432 on the database security group to the Open WebUI task. That rule lives in the App stack. Monitoring only reads earlier stacks.

**The workflow trigger listens to Orchestration.** The rule cannot listen for an earlier stack to finish, because that event fires before this rule exists. Orchestration depends on App, and the rule matches only Orchestration’s own `CREATE_COMPLETE` and `UPDATE_COMPLETE`. A deploy that changes nothing does not emit a new event. The one-shot tasks are started by family name, not by a task-definition revision export. A new image updates App only. It does not update Orchestration, so it does not start the workflow. After that app deploy, start `chapters-bootstrap-<stage>` once.

## What you do once, before the first deploy

Create `.env` locally. Do not commit it. Commit `.env.example` with empty values.

```
OPENAI_API_KEY=
GITHUB_TOKEN=
WEBUI_ADMIN_EMAIL=
WEBUI_ADMIN_PASSWORD=
```

`OPENAI_API_KEY` comes from your OpenAI account. `GITHUB_TOKEN` is a fine-grained GitHub token with Contents, Issues, and Pull requests set to Read, and no write. The email and password are the admin login you will send to the interviewers.

CDK reads those four values from the environment during deploy. `infra/.env` fills in any value the shell has not already set. Another environment supplies its own values the same way. The stack passes each one to the task that needs it.

The committed config files hold the rest. Shape, not a secret:

```yaml
SERVICE: org
NAME: chapters
OWNER: chaptersag
BUCKET_NAME: chapters-openwebui-dev
WEB_DOMAIN_NAME: dev-client-openwebui.flexxytech.com
ALLOWED_IPS:
  - 0.0.0.0/0
DOMAIN_HOSTED_ZONE_ID: ...
DOMAIN_HOSTED_ZONE_NAME: flexxydrive.com
CERTIFICATE_ARN: arn:aws:acm:us-east-1:...
SNS_EMAIL: you@example.com
RAG_EMBEDDING_MODEL: text-embedding-3-small
OPEN_WEBUI_IMAGE: ghcr.io/open-webui/open-webui:v0.12.5
OIKB_IMAGE: ghcr.io/open-webui/oikb:0.6.0
MCP_IMAGE: ghcr.io/github/github-mcp-server:v2.0.3
MONTHLY_BUDGET_USD: 200
```

`infra/config.prod.yaml` is the same shape with the prod hostname, bucket, and allowed IPs.

## What the one command does

`cdk deploy --all` builds the five stacks and returns. The assistant is not ready at that moment. EventBridge then starts Step Functions inside AWS.

You still click the SNS subscription email once. Confirm the separate budget email, and activate the `Service` cost allocation tag in Billing once. The ready email is the signal that the assistant exists. Send the URL to the interviewers after that mail, not when CDK exits.

## Runtime shape

```text
Browser
  -> https://<WEB_DOMAIN_NAME>   (ALLOWED_IPS only)
    -> load balancer (HTTPS, HTTP redirects)
      -> Open WebUI, one Fargate task
         PostgreSQL: accounts, assistant, vectors
         S3: file bytes of the synced repo

Open WebUI
  -> private github-mcp task, through github-mcp-proxy on port 8082
       GitHub token stays in github-mcp-proxy

oikb-daemon, one Fargate task, started only after bootstrap
  -> reads github.com/open-webui/oikb
  -> writes into the Open WebUI knowledge base
  -> on sync error, POSTs to 127.0.0.1 in the same task
       the signer calls the notify function URL with IAM
       the Lambda emails you
```

Open WebUI is the official image, not a fork. Pin `v0.12.5`, which is above the `0.9.6` oikb needs. Do not use `:main`. Keep the image entrypoint. The migration task is the only one that overrides the command.

The github-mcp image is `ghcr.io/github/github-mcp-server`, command `http --read-only --listen-host 127.0.0.1 --port 8083`. The pin is `v2.0.3`, which is after the HTTP read-only fix. That HTTP mode does not read `GITHUB_PERSONAL_ACCESS_TOKEN`. github-mcp-proxy in the same task (`containers/github-mcp-proxy`) listens on port `8082`, adds `Authorization: Bearer` from that secret, and forwards to github-mcp on `127.0.0.1:8083`. Open WebUI still registers github-mcp with no token. Bootstrap fails if the tool list contains a write tool. Open WebUI reaches port `8082` through private Cloud Map DNS. github-mcp is not on the load balancer, and port `8083` is not open on the task security group.

The oikb image is the official one, command `daemon`, one oikb-daemon task. Its config file is committed. The knowledge-base id and the Open WebUI API key are filled from secrets at runtime. Interval is 15 minutes.

## Open WebUI task settings

Plain environment values come from the stage config and from stack outputs. They are not secrets.

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `UVICORN_WORKERS` | `1` |
| `WEBUI_URL` | `https://` plus `WEB_DOMAIN_NAME` |
| `CORS_ALLOW_ORIGIN` | The same address. The image default `*` is not used. `*` lets any other website call the API from a visitor's browser and use that visitor's login. The site's own pages are this address, so they keep working |
| `ENABLE_DB_MIGRATIONS` | `false` on the service. `true` only on the migration task |
| `ENABLE_OLLAMA_API` | `false` |
| `ENABLE_API_KEYS` | `true` |
| `ENABLE_SIGNUP` | from `.env`. Open WebUI turns this off when it creates the first admin, and bootstrap sets it back |
| `DEFAULT_USER_ROLE` | from `.env`. `user` means a new account can use the site without approval |
| `VECTOR_DB` | `pgvector` |
| `PGVECTOR_CREATE_EXTENSION` | `false` |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `RAG_OPENAI_API_BASE_URL` | `https://api.openai.com/v1` |
| `RAG_EMBEDDING_ENGINE` | `openai` |
| `RAG_EMBEDDING_MODEL` | from config |
| `STORAGE_PROVIDER` | `s3` |
| `S3_BUCKET_NAME` | the stage bucket |
| `S3_REGION_NAME` | `us-east-1` |

These guide settings are not set. `WEBSOCKET_MANAGER=redis` and the Redis URLs need Redis. `CONTENT_EXTRACTION_ENGINE=tika` and `TIKA_SERVER_URL` need a Tika server. This demo runs neither, so file extraction stays on the image’s built-in extractor. There is no `LICENSE_KEY`.

Secrets are injected from Secrets Manager. The environment name and the secret ARN are separate fields. Two names may use the same secret. They are read when the task starts.

| Variable | Secret |
|---|---|
| `WEBUI_SECRET_KEY` | Generated by CDK, stable for the stage |
| `DATABASE_URL` and `PGVECTOR_DB_URL` | The same PostgreSQL URL, including the password |
| `OPENAI_API_KEY` and `RAG_OPENAI_API_KEY` | The OpenAI key from `.env` |
| `WEBUI_ADMIN_EMAIL` and `WEBUI_ADMIN_PASSWORD` | From `.env`. Applied only when the database has no users |

The execution role may pull the image, write logs, and read those secrets, including KMS decrypt where the secret uses a customer key. The task role may read and write only this stage’s bucket. No AWS access keys are placed in the task.

## Persistence

PostgreSQL holds the app data and the vector index. S3 holds the uploaded file bytes. One database, single-AZ, not reachable from the internet. One bucket. One Open WebUI task. No filesystem on the task.

RDS will not create the `vector` extension by itself. Step Functions runs a one-shot database task that runs `CREATE EXTENSION IF NOT EXISTS vector` before Open WebUI migrates. That matches `PGVECTOR_CREATE_EXTENSION=false`.

The Open WebUI service is created with zero tasks. The migration task uses the same image and the same secrets, with `ENABLE_DB_MIGRATIONS=true` and the command `python -c "import open_webui.config"`. Continue only when that task exits 0. The service then starts with migrations off. On `v0.12.5`, importing `open_webui.config` still runs Alembic when `ENABLE_DB_MIGRATIONS` is true. Check it again if the image tag changes.

Tasks run in private subnets with no public IP. One NAT gateway in a public subnet carries their calls to OpenAI, GitHub, and the image registries. The load balancer stays in the public subnets. PostgreSQL is in isolated subnets, with no route to the internet. The Open WebUI security group accepts port `8080` only from the load balancer. The github-mcp security group accepts `8082` only from the Open WebUI task.

## Keys

| Secret | Where it comes from |
|---|---|
| OpenAI key | `.env`, then Secrets Manager in `us-east-1` |
| GitHub read-only token | `.env`, then Secrets Manager. Injected into github-mcp-proxy, bootstrap, and oikb-daemon. The website task does not receive it |
| Admin email and password | `.env`, then Secrets Manager |
| Signing key | Generated by CDK |
| Database URL | Generated from the RDS master secret |
| oikb-daemon key | Generated by CDK. A password we invent so only our tasks can call oikb-daemon |
| Open WebUI API key | Created by bootstrap with `POST /api/v1/auths/api_key`, then stored. oikb-daemon uses it to upload files |
| Knowledge-base id | Returned when bootstrap creates the library, then stored for oikb-daemon |

## Stacks

**Network.** One VPC across two availability zones. Public subnets hold the load balancer and one NAT gateway. Private subnets hold the tasks. Their route to S3 is a gateway endpoint. Everything else still uses the NAT gateway. Isolated subnets hold PostgreSQL and have no internet route and no S3 route.

**Data.** Depends only on Network. PostgreSQL, the stage bucket, and the database security group. No reference to ECS, the load balancer, or the hostname.

**App.** Depends on Network and Data. Cluster, load balancer, access-log bucket, DNS alias, certificate, Open WebUI service at zero tasks, private github-mcp service at one task, github-mcp-proxy in that task, oikb-daemon service at zero tasks, the localhost signer in the oikb-daemon task, the sync-metrics sidecar that publishes `Chapters/Oikb` from oikb-daemon's `/metrics` and `/health` pages, migration task definition, bootstrap task definition, log groups, Cloud Map namespace. Adds the database ingress rule for the Open WebUI security group. The SNS topic and the notify Lambda live here too. The function URL requires IAM, and only the oikb-daemon task role may call it. Putting that Lambda in Orchestration would make App and Orchestration depend on each other.

**Orchestration.** Depends on App. State machine, and the EventBridge rule for this stack’s own completion. It publishes ready and failure mail to the App stack topic. Vector, migrate, and bootstrap are started by family name, so a new image does not change an export this stack imports. The workflow still receives the task roles, the cluster, and the website and oikb-daemon services from App.

**Monitoring.** Depends on Orchestration, and reads App and Data. Alarms, a Lambda that turns each alarm into a plain email on the existing topic, one dashboard, a monthly budget, and a WAF rate limit on the load balancer. The dashboard shows the live task counts, the latest sync, and the `Chapters/Oikb` totals. Task alarms use `LiveTaskCount`. A missing value does not alarm. A reported count below 1 for 15 minutes does. The website health alarm and the sync-status alarm require the task to be live.

`cdk deploy --all` deploys them in that dependency order.

## Workflow

1. Create the `vector` extension.
2. Run the Open WebUI migration task. Continue only on exit code 0.
3. Set the Open WebUI service to one task.
4. Wait 30 seconds. The workflow does not poll the health check.
5. Run the bootstrap task with `ecs:runTask.sync`. The call includes the private subnets and the security group. The task has no public IP. The state machine role can run the task, pass its roles, and manage the EventBridge rules Step Functions creates for the wait. Bootstrap polls `/health/db` for up to 20 minutes.
6. On exit 0, set oikb-daemon to one task.
7. Email that the demo is ready, with the site URL.

On any failure, email the stage, the site URL, the time, the Step Functions error, and the log group names. Do not start oikb-daemon.

`entrypoint.sh` only starts the Python program. The program is idempotent.

1. Wait for `/health/db`.
2. Sign in with `POST /api/v1/auths/signin`.
3. Create the Open WebUI API key if missing, and store it.
4. Create or reuse the knowledge base named `oikb`. Store its id.
5. Register private github-mcp with `POST /api/v1/configs/tool_servers`. Type `mcp`, and `info.id` set. Read the saved connection back. Fail if a write tool is present.
6. Import the model `oikb Ops Assistant` with `POST /api/v1/models/import`. System text in `params.system`. The description under the name is in `meta.description`: "Answers from the oikb knowledge base, and from read-only GitHub when a question needs a live issue, commit, or pull request." Knowledge in `meta.knowledge`, using the object the knowledge API returned. The github-mcp tool in `meta.toolIds`, using the id Open WebUI saved. The base model is the first cheap chat model listed by `GET /api/models`, in this order: `gpt-5-mini`, `gpt-4.1-mini`, `gpt-4o-mini`. Transcription, audio, image, and other non-chat ids are skipped. A later import replaces the saved base model.
7. Sync `github:open-webui/oikb` once.
8. Wait until those files are processed. Read them from `GET /api/v1/knowledge/{id}/files`. The knowledge record itself does not include the file list. Also wait until `GET /api/v1/knowledge/{id}/files/pending` is empty. Then ask the three required questions via `POST /api/chat/completions`.
9. Write the answers to `reports/<stage>/latest.json` and the short summary to `latest.txt`. When `latest.json` already exists, keep that previous report as `reports/<stage>/<stamp>.json` before replacing it. The new run is not also stored under a date.

Exit 0 when setup succeeded, even if an answer is weak. The report marks evaluation separately from infrastructure. Exit non-zero when setup itself failed. A second run reuses the same library and model.

## Evaluation

Required questions:

1. Where in the code are the oikb commands defined?
2. Where in the code are GitHub webhooks processed?
3. Which connectors does oikb currently provide?

Record the question, the answer, whether Open WebUI returned a source citation, pass or fail, and a one-sentence reason for that result. Pass means a citation is present and the answer names a path-like file, or, for the connectors question, a connector name. A person still checks that the path is real. The written eval proposal, after the system works, describes this check and names the S3 report as the first run of it.

## Security

- The GitHub token cannot write, and github-mcp is started read-only. Bootstrap rejects a tool list that can write.
- The Open WebUI execution role reads secrets and writes logs. The task role can touch only the stage bucket. It has no GitHub identity and no embedded AWS keys.
- oikb-daemon can call Open WebUI, read the public repo with the read-only GitHub token, invoke the notify function URL, and publish CloudWatch metrics in `Chapters/Oikb`. The signer listens on `127.0.0.1:8089`. The metrics reader listens on `127.0.0.1:8091`. Neither port is published. The website task has no GitHub token.
- Nothing secret is in git, in the yaml configs, or in image layers.
- The load balancer is the only public door. HTTPS uses the stage certificate. Ingress is limited to `ALLOWED_IPS`. Both stage files currently set that to `0.0.0.0/0`, and the WAF caps each address at 2000 requests per five minutes. Tasks have no public IP. PostgreSQL has no route to the internet. The database-URL writer and the notify Lambda stay outside the VPC.

## Repository layout

```text
.env.example
infra/                 CDK app and the five stacks
  config.dev.yaml
  config.prod.yaml
  types.ts
  utils/index.ts       stagified
bootstrap/             Python setup and evaluation runner
containers/            Dockerfiles and the thin entrypoint
docs/README.md
docs/overview.md
docs/architecture.md
docs/decision-record.md
docs/eval-proposal.md
docs/deploy.md
docs/reference.md
docs/adr/                 one ADR per decision
docs/plan.md              this contract
```

The public architecture, decision record, and ADRs describe the system as built. The eval proposal describes the check. The first scored run is still the S3 report from a real bootstrap, not a result invented in the write-up. Those pages are not generated by the workflow.

## Left out, on purpose

More than one Open WebUI task. Redis and websocket fan-out. Tika. A mirror of the images into ECR. An automated grader that runs forever. A webhook from GitHub into oikb-daemon. RDS Proxy. oikb-daemon’s 15-minute interval is the freshness mechanism. The error POST is the failure email. Finished syncs are graphed from `/metrics`. A hung sync does not page anyone.

## Build order, after this plan is accepted

1. Stage configs, `stagified`, `.env.example`, and gitignore.
2. Network, then Data.
3. App: Open WebUI at zero tasks, migration task, github-mcp service, load balancer and DNS.
4. Bootstrap image, run once by hand against a started site, until the model exists.
5. Orchestration workflow and the two emails.
6. Daemon at zero, then scaled up by the workflow.
7. One clean `cdk deploy --all` for `dev`, then a second deploy to prove reuse.
8. Public architecture, decision record, ADRs, and eval proposal. The scored answers still come from the S3 report after a real run.
