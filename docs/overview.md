# Overview

Read this first. It is the map of the project: what problem it solves, what is running, how a question is answered, what happens after deploy, and where the other pages go deeper.

The running system is an Open WebUI site on AWS. The support assistant `oikb Ops Assistant` answers from a knowledge base that lives in Open WebUI.

The one-shot setup program, `python -m bootstrap.run`, creates that knowledge base on the first run. It sends the name `oikb` with the create request, and Open WebUI assigns the id. A later run finds the knowledge base by that name and keeps it.

oikb keeps that knowledge base current with a long-running daemon. Its GitHub connector reads the public repository `github.com/open-webui/oikb` and writes the files into the knowledge base. The daemon's own timer runs that sync every 15 minutes, after the setup program has synced once, so the copy the assistant searches can lag `main` by that long.

Two other ways stay open for later. See [ADR 0001](adr/0001-freshness.md). A GitHub webhook can ask the daemon to sync on each push once an owner or an admin of `open-webui/oikb` adds the hook. The token in this deployment reads Contents, Issues, and Pull requests, so adding that hook belongs to whoever controls the repository. The 15-minute timer would stay, so a missed hook would still sync. Alternatively, that same read token could check the latest commit and start a sync only when the commit changes.

When a question needs a live look at issues or recent changes, the assistant can also call GitHub, and that call is read-only. If the copy stops updating, an email goes out. The infrastructure is CDK in `infra/`. The pages under `docs/` are the write-up that goes with it.

## The problem

CHAPTERS runs a shared chat product, Open WebUI, for the companies it owns. A platform admin's support team uses a tool called oikb to help customers set up knowledge-base sync. The copy of oikb's documentation and code inside the Hub is stale, so support answers from old material.

The admin wants four things:

- An assistant that answers from the current oikb repository.
- That same assistant to notice when a question touches a known bug or a recent change.
- A guarantee that the Hub cannot change any code repository. Read is allowed. Write is not.
- A way to hear that the sync is broken before the support team notices it.

This repository is a small, real version of that. Leaving extra machinery out is part of the design. The [decision record](decision-record.md) answers the task's four questions. [ADR 0004](adr/0004-scope.md) says how to add what was left out.

## What is running

Three tasks stay up. Three others run once during setup and then exit.

| Piece | What it does |
|---|---|
| Open WebUI | The website. One Fargate task on port 8080. Users, chats, the assistant, and the knowledge base live here. |
| GitHub MCP | A private Fargate task. Open WebUI calls it when a question needs live GitHub data. It cannot write. |
| oikb daemon | Keeps the knowledge base aligned with `github.com/open-webui/oikb`. It starts only after setup succeeds, then syncs every 15 minutes. |
| Vector task | One shot. Runs `CREATE EXTENSION IF NOT EXISTS vector` so the database can store embeddings. |
| Migrate task | One shot. Applies Open WebUI's database schema. The website itself has migrations turned off, so a restart does not change the schema. |
| Bootstrap | One shot. Signs in, creates or reuses the knowledge base named `oikb`, creates the assistant, registers the GitHub tool, syncs once, asks three check questions, and writes a report to S3. |

Two tasks carry small helper programs, and those programs are not their own services. In the GitHub task, `containers/mcp-proxy` listens on port 8082, adds the GitHub token, and forwards to the MCP process on `127.0.0.1:8083`. In the daemon task, `containers/notify-proxy` listens on `127.0.0.1:8089` and signs the error report, and `containers/sync-metrics` reads the daemon's metrics page. Those ports are not reachable from the internet.

## A question, from the browser

A person opens `https://` plus the stage hostname. The load balancer accepts only `ALLOWED_IPS`. Both stage files currently set that to `0.0.0.0/0`, so the public name is open and the WAF is the throttle: 2000 requests per address every five minutes. Port 80 redirects to 443. The load balancer sends the request to the one Open WebUI task.

Open WebUI reads the account, the chat, and the assistant from PostgreSQL. The assistant's documents are the knowledge base. The file bytes of those documents are objects in the stage S3 bucket. The embeddings that make search work are pgvector rows in the same database.

If the question needs a live look at GitHub, Open WebUI calls `http://github-mcp.chapters-<stage>.local:8082`. That name exists only inside the VPC. The MCP server was started with `--read-only`, and the token it uses can only read Contents, Issues, and Pull requests. Bootstrap refuses to finish if a write tool shows up in the tool list. The website task never receives the GitHub token.

## How the library stays current

The daemon's GitHub connector reads `github.com/open-webui/oikb` and writes those files into the Open WebUI knowledge base. `containers/oikb/.oikb.yaml` names that source `github:open-webui/oikb` and sets the interval to 15 minutes, so the library can lag `main` by that long. Files that leave the repository are removed on a later sync. Re-checking a public repository that has not changed is cheap.

Once a minute, a small program in that same task reads the daemon's `/metrics` page and publishes the change to CloudWatch: syncs that succeeded, finished with some file errors, or failed, files uploaded and deleted, and how long the sync took. The dashboard graphs those. The first page is only a starting point, so a number appears when the count actually changes.

On a sync error the daemon POSTs to `127.0.0.1:8089` in the same task. The signer there calls the notify Lambda with the daemon's task role. The function publishes to an SNS topic, and the topic emails the address in the stage file. The same topic carries the ready mail, the setup-failure mail, and the health alarms. The subscription has to be confirmed once by a person. Until that click, none of those emails arrive.

## After deploy

`cdk deploy --all` builds the AWS resources and returns before the assistant exists. EventBridge then starts a Step Functions workflow when the Orchestration stack finishes creating or updating. The workflow runs in this order:

1. Create the pgvector extension.
2. Run the Open WebUI migration.
3. Start one website task.
4. Wait 30 seconds, then run bootstrap. Bootstrap polls `/health/db` for up to 20 minutes.
5. Start one daemon task.
6. Send the ready email.

The ready email contains the site URL. It does not contain the admin password. Sign in with `WEBUI_ADMIN_EMAIL` and `WEBUI_ADMIN_PASSWORD` from `infra/.env`.

Bootstrap signs in as that admin. Two secrets, the Open WebUI API key and the knowledge-base id, are created at deploy with the literal value `pending`. Bootstrap replaces both. For the knowledge base, it asks Open WebUI for the list. If a base named `oikb` already has an id, that id is reused. Otherwise it calls `POST /api/v1/knowledge/create` with the name `oikb`, and Open WebUI assigns the id in the response. This repository does not generate that id. Bootstrap writes it into Secrets Manager, and the daemon later reads it as `KB_ID`.

Bootstrap then registers the MCP server, imports the assistant `oikb Ops Assistant`, syncs the repository once, waits until those files are processed, asks the three evaluation questions, and writes `reports/<stage>/latest.json` in the stage bucket. A weak answer is recorded and does not fail the deploy. A setup failure (health, sign-in, a write tool, file processing) fails the task, the failure email goes out, and the daemon stays off.

A later deploy that only changes the application image does not start this workflow by itself. After that deploy, start the state machine `chapters-bootstrap-<stage>` once. That run keeps the existing `oikb` knowledge base and assistant. The steps are in [Deploy](deploy.md).

## What survives a new container

Fargate replaces the task disk when a task stops. The Open WebUI task mounts no volume, so a restart, a deploy, or a crash leaves an empty container filesystem. Anything that must still be there lives outside the task.

| What | Where |
|---|---|
| Users, chats, settings, the assistant, knowledge-base rows | RDS PostgreSQL 16, database `openwebui` |
| Session cookies | Signed with `WEBUI_SECRET_KEY`, generated once per stage and kept in Secrets Manager. A new task reads the same key, so an existing login still works. |
| Embeddings | pgvector in that same database |
| Synced file bytes, and the evaluation report | The stage S3 bucket |

The database is encrypted, single-AZ, and closed to the internet. It sits in isolated subnets with no route out. Tasks connect straight to it. There is no RDS Proxy. One website task with one worker process does not need a connection pool in front of PostgreSQL.

## Names, networks, and who can connect

Everything is in `us-east-1`. The VPC has public, private, and isolated subnets across two availability zones, and one NAT gateway.

The load balancer and the NAT gateway sit in the public subnets. Open WebUI, the GitHub helper, the daemon, and the one-shot tasks sit in the private subnets with no public IP. Their calls to OpenAI, GitHub, and the public image registries go out through the NAT gateway. Their calls to S3 use a gateway endpoint on the private route tables, so that traffic does not pass through the NAT. PostgreSQL sits in the isolated subnets and has no route to S3.

Two DNS names matter, and they are not the same thing:

- The public name, from the stage file, points at the load balancer. That is the URL in the ready email.
- The App stack creates a private Cloud Map namespace `chapters-<stage>.local` in the VPC. The website registers as `web` on port 8080 (`http://web.chapters-<stage>.local:8080`). The GitHub helper registers as `github-mcp` on port 8082 (`http://github-mcp.chapters-<stage>.local:8082`). Those names resolve only inside the VPC. Bootstrap and the daemon use them, so those calls never go through the public load balancer or its IP allow-list.

## The five stacks

CDK deploys five stacks, and each one may use only the stacks before it. Data does not know the website exists. Monitoring only reads the earlier stacks.

| Order | Stack | Owns |
|---|---|---|
| 1 | Network | The VPC, the subnets, one NAT gateway, and an S3 gateway endpoint on the private subnets |
| 2 | Data | PostgreSQL, the stage bucket, and the database security group |
| 3 | App | The cluster, the load balancer, the public DNS name, the private Cloud Map namespace, the three services, the one-shot task definitions, the sync metrics publisher, the SNS topic, and the notify Lambda |
| 4 | Orchestration | The setup workflow and the rule that starts it |
| 5 | Monitoring | Alarms, plain-language alarm mail, the dashboard, a monthly budget, and the WAF rate limit |

The App stack is the one that opens port 5432 from the application tasks to the database. Stage settings that are safe to commit live in `infra/config.dev.yaml` and `infra/config.prod.yaml`. Names go through `stagified` in `infra/utils/index.ts`, so a dev resource and a prod resource do not collide. Secrets (`OPENAI_API_KEY`, `GITHUB_TOKEN`, the admin email and password) come from the environment at deploy time, filled in from `infra/.env` when the shell has not set them. That file is not committed.

Images, ports, and environment variables are listed in the [reference](reference.md).

## The four decisions

These are the task's four questions. The options, the trade-off, and what would change the choice are in the [decision record](decision-record.md). The longer write-up of each is the ADR with the same number.

1. **Freshness.** Fifteen minutes is fresh enough. The daemon's own schedule triggers the sync, and the sync runs in its own task. See [ADR 0001](adr/0001-freshness.md).
2. **Access scope.** The MCP task is private, started with `--read-only`, and the token can only read Contents, Issues, and Pull requests. The website task does not receive the token. See [ADR 0002](adr/0002-access-scope.md).
3. **Failure detection.** A reported sync error emails the admin. A setup that never starts the daemon sends a different email. A sync that hangs without an error does not. See [ADR 0003](adr/0003-failure-detection.md).
4. **Scope.** Leave out a second website task, Redis, Tika, an ECR copy of the images, a webhook, a standing grader, and RDS Proxy. Those are extra. The URL, the current library, read-only GitHub, durable sessions, and the failure email are not. See [ADR 0004](adr/0004-scope.md).

## What this demo leaves out

On purpose: a second website task, Redis, Apache Tika, a private copy of the public images in ECR, a GitHub webhook, a grader that keeps scoring chats after bootstrap, and RDS Proxy. Before prod is a real environment, confirm the certificate and `SNS_EMAIL`, and replace `ALLOWED_IPS: 0.0.0.0/0`. How to add each item is in [ADR 0004](adr/0004-scope.md).

## Where to go next

| If you want | Read |
|---|---|
| The request path, the network, and what each stack owns, in more detail | [Architecture](architecture.md) |
| Why a choice was made, and how to add what was left out | [Decision record](decision-record.md) and the [ADRs](adr/0001-freshness.md) |
| How a deploy actually goes, including the email you have to confirm | [Deploy](deploy.md) |
| Images, ports, environment variables, and secrets | [Reference](reference.md) |
| How assistant answers are judged | [Eval proposal](eval-proposal.md) |
