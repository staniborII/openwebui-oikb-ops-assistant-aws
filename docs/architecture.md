# Architecture

The short tour of the whole system is the [overview](overview.md). This page is the closer look at the request path, the network, and where data lives.

Open WebUI is the website. oikb keeps a knowledge base in that website aligned with the public repository `github.com/open-webui/oikb`. The saved assistant `oikb Ops Assistant` answers from that library and can call private, read-only github-mcp when a question needs a live look at issues or recent changes. The CDK app in `infra/` is the definition of those resources.

`cdk deploy --all` synthesizes that definition into CloudFormation and returns once the stacks exist, before the assistant exists. When the Orchestration stack itself reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`, CloudFormation emits a stack status event. The EventBridge rule `chapters-stack-complete-<stage>` matches that event for this stack only and starts the Step Functions state machine `chapters-bootstrap-<stage>`. The workflow's last step publishes to the stage SNS topic.

That ready email goes to `SNS_EMAIL`. The subject is `Open WebUI <stage> is ready` and the body is the site URL, with a reminder to sign in using the admin email from `infra/.env`. That email means setup has finished: the vector extension, the schema migration, the website, bootstrap, and oikb-daemon are all up. Send people the URL in the email. The same note is posted to Slack.

The task's four decisions are the [decision record](decision-record.md) and the [ADRs](adr/0001-freshness.md). Compute and where data lives are described in this page.

## Services and proxies

Three ECS services stay up. A proxy is another container in that same task. Containers in one task share localhost, so a proxy can reach its upstream without a security-group rule. The shorter map of the same pieces is in the [overview](overview.md).

| Piece | Listens | Called by | What it does |
|---|---|---|---|
| Open WebUI | Port 8080. Cloud Map name `web.chapters-<stage>.local` | The load balancer, bootstrap, and oikb-daemon | The website. Accounts, chats, the assistant, and the knowledge base. |
| github-mcp | `127.0.0.1:8083` in the github-mcp task | github-mcp-proxy | GitHub's MCP server, command `http --read-only`. It calls GitHub. Nothing outside the task can open this port. |
| github-mcp-proxy | Port 8082. Cloud Map name `github-mcp.chapters-<stage>.local` | Open WebUI, from the application security group | Drops any Authorization header on the incoming request, adds `Authorization: Bearer` with the GitHub token, and forwards to github-mcp. The response status and body go back unchanged. |
| oikb-daemon | Port 8080 inside the oikb-daemon task | sync-metrics, on localhost | Reads `github.com/open-webui/oikb` and writes the files into Open WebUI at `http://web.chapters-<stage>.local:8080`. `GET /metrics` is its Prometheus page. `GET /health` is its health page. |
| notify-proxy | `127.0.0.1:8089` | oikb-daemon, on a sync error | Signs the POST with the oikb-daemon task role and calls the notify Lambda function URL. |
| sync-metrics | `127.0.0.1:8091`, `GET /health` only | ECS, for the container health check | Once a minute, reads `http://127.0.0.1:8080/metrics` and `GET /health` on oikb-daemon and publishes the current totals and the latest sync to CloudWatch namespace `Chapters/Oikb`. |

The AWS services around those tasks:

| Service | What it does |
|---|---|
| Application Load Balancer | Public entry. Port 80 redirects to 443. The target group contains only Open WebUI. Access logs are kept 14 days. `ALLOWED_IPS` limits who can connect. |
| WAF | 2000 requests per five minutes per address. |
| RDS PostgreSQL 16 | Database `openwebui`, in the isolated subnets. Accounts, chats, sessions, the assistant, knowledge-base rows, and pgvector embeddings. Clients connect on 5432. |
| Stage S3 bucket | Synced file bytes and the evaluation report. Private-subnet calls use the S3 gateway endpoint. |
| Cloud Map | Namespace `chapters-<stage>.local`, described in the next section. |
| NAT gateway | One gateway, in a public subnet. Private-subnet calls to OpenAI, GitHub, and the public image registries leave through it. |
| Notify Lambda `chapters-oikb-notify-<stage>` | Function URL, IAM auth. Publishes the signed sync-error body to the alerts topic. |
| Slack Lambda `chapters-slack-<stage>` | Subscribed to that topic. Posts the same subject and body to Slack. The webhook URL is `SLACK_WEBHOOK_URL` in `infra/.env`. |
| SNS topic `chapters-alerts-<stage>` | Emails `SNS_EMAIL`. Ready mail, setup failure, sync errors, and health alarms share this topic. |
| EventBridge rule `chapters-stack-complete-<stage>` | Matches this Orchestration stack's `CREATE_COMPLETE` and `UPDATE_COMPLETE`, and starts the setup workflow. |
| Step Functions `chapters-bootstrap-<stage>` | Creates the vector extension, runs the migration, starts the website, runs bootstrap, starts oikb-daemon, and sends the ready email. |

## The assistant

`oikb Ops Assistant` (id `oikb-ops-assistant`) is the saved model bootstrap imports. The base model is the first of `gpt-5-mini`, `gpt-4.1-mini`, and `gpt-4o-mini` that Open WebUI lists. The description under the name is: "Answers from the oikb knowledge base, and from read-only GitHub when a question needs a live issue, commit, or pull request." What the filter keeps, and what it leaves out, is in the [overview](overview.md).

| Kind | What is used | What it does |
|---|---|---|
| Skills | None attached | A workspace skill is a markdown file the model loads when a task needs those steps. The system prompt on every call is: "You are the oikb Ops Assistant. Answer from the oikb knowledge base and the read-only GitHub tools. Name the file or connector you used." |
| Rules | Filter `oikb_context_budget` | Installed by bootstrap and limited to this assistant. It runs on the request hook after retrieval and after the tool definitions are attached. It keeps that model request inside a cap that follows the selected model: 80,000 tokens for `gpt-4o-mini`, 170,000 for `gpt-5-mini`, and 650,000 for `gpt-4.1-mini`, estimated as characters divided by 4. An unknown model uses 80,000. The stored chat stays complete. Open WebUI's context compaction stays off. If the filter fails, the request keeps the system prompt and the current question. |
| Rules | Write-tool check | `register_github_mcp` in `bootstrap/run.py` reads the tool list. An empty list, or a name containing a write marker such as `create_`, `update_`, `delete_`, `push_`, or `merge_`, fails setup. The daemon task stays at zero. |
| MCP | `github-mcp` | Saved under Open WebUI tool servers as type `mcp`, auth `none`, URL `http://github-mcp.chapters-<stage>.local:8082`. The assistant's tool id is `server:mcp:github-mcp`. The token stays in github-mcp-proxy. |
| Tools | Default toolsets, read-only | No `--toolsets` flag is set, so github-mcp `v2.0.3` registers its default sets: context, repos, issues, pull requests, and users. `--read-only` does not register the write tools in those sets. The model uses the read tools when a question needs a live issue, pull request, commit, or file. The synced library is the `oikb` knowledge base. |

## Cloud Map

DNS turns a name into an address. Cloud Map is the private phone book for this VPC. A lookup from a task inside the VPC returns another task's private IP. A computer outside the VPC cannot resolve the name.

The App stack creates the zone `chapters-<stage>.local` and registers two names:

- `web.chapters-<stage>.local` is the Open WebUI task, port 8080. Bootstrap and oikb-daemon call `http://web.chapters-<stage>.local:8080`.
- `github-mcp.chapters-<stage>.local` is github-mcp-proxy, port 8082. Open WebUI calls `http://github-mcp.chapters-<stage>.local:8082`.

Those calls stay on the private addresses. The tasks have no public IP.

The public site name is a separate record. It points at the load balancer, and the load balancer forwards only to Open WebUI. The load balancer accepts `ALLOWED_IPS`.

## Request path

```text
Browser
  -> the public name https://<WEB_DOMAIN_NAME>
       ALLOWED_IPS, currently 0.0.0.0/0 in both stage files
    -> WAF
         2000 requests per five minutes per address
      -> Application Load Balancer
           port 80 redirects to 443 (ensuring all unencrypted web traffic is encrypted and secure.); access logs kept 14 days
        -> Open WebUI, container web, running on port 8080
             one Fargate task
             RDS PostgreSQL holds accounts, chats, sessions, the assistant, and vectors
             S3 holds the file bytes of the synced repository

A question that needs live GitHub leaves the website for the github-mcp task
  Open WebUI calls github-mcp-proxy first. github-mcp only
  listens on localhost inside that same task, so the website cannot reach
  it directly.
  -> github-mcp-proxy, running on port 8082
       The model decides it needs GitHub and calls the tool at
       http://github-mcp.chapters-<stage>.local:8082.
       Cloud Map turns that name into the private IP of the github-mcp task.
       The Cloud Map section above registers that name.
       github-mcp-proxy drops any Authorization header on the incoming request
       and adds Authorization: Bearer with the GitHub token.
       The token stays in github-mcp-proxy. Open WebUI never receives it.
    -> github-mcp on 127.0.0.1:8083 in the same task
       That process was started with --read-only.
       It calls GitHub.
    <- GitHub's answer comes back to github-mcp
       github-mcp-proxy pipes that response straight back to Open WebUI:
       the same status code and the same body.
       github-mcp-proxy does not rewrite it.
  <- Open WebUI gives that tool result to the model
       The model writes the reply.
       Open WebUI sends that reply back through the load balancer
       to the browser.

oikb-daemon, one Fargate task, started after bootstrap
  Three containers share this task, so 127.0.0.1 is the task itself.
  -> oikb-daemon, the oikb image, reads github.com/open-webui/oikb
       and writes the files into Open WebUI, container web, running at
       http://web.chapters-<stage>.local:8080
       oikb-daemon itself runs on port 8080 inside this task.
       GET /metrics there is its Prometheus page.
  -> on a sync error, oikb-daemon POSTs to notify-proxy, running on 127.0.0.1:8089
       notify-proxy is bound to localhost in this task
       it signs the request with the oikb-daemon task role
       and calls the notify Lambda function URL
       the function publishes to SNS
       SNS emails the address in the stage file
       and a Lambda posts that same subject and body to Slack
  -> once a minute, sync-metrics reads oikb-daemon's Prometheus page
       at http://127.0.0.1:8080/metrics
       and GET /health on that same port
       and publishes the current totals and the latest sync to CloudWatch
       namespace Chapters/Oikb
       a sync still running after an hour raises an alarm on that topic
       a live daemon task that stops reporting does too
       sync-metrics also listens on 127.0.0.1:8091, and that port only
       answers GET /health so ECS can tell the container is up. The sync
       numbers come from oikb-daemon on port 8080.
```

`CORS_ALLOW_ORIGIN` is `https://<WEB_DOMAIN_NAME>`, the same address as `WEBUI_URL`. The image default is `*`, which lets any other website call the API from a visitor's browser and use that visitor's login. With the public address set, that other website is refused. Opening this site in a browser still works, because the page and the API are that same address.

The programs are `containers/github-mcp-proxy`, `containers/notify-proxy`, and `containers/sync-metrics`. A source that has been `running` for more than an hour raises an alarm on the alerts topic. The filter on `oikb Ops Assistant` is the rule in the assistant table above.

## Compute

The workloads run as ECS Fargate services and one-shot tasks in `us-east-1`. There is no Kubernetes control plane.

EKS was the other serious option. It would give a cluster API, Deployments, and a place to add later services with the same tooling. This demo is three long-running tasks (the website, github-mcp, oikb-daemon) plus short-lived migration, vector, and bootstrap tasks. An EKS control plane would be a second system to pay for, upgrade, and explain, beside a CDK app that already states the task definitions. Fargate starts those tasks from the task definition. There are no nodes to patch.

The trade-off is the Kubernetes feature set. There is no Horizontal Pod Autoscaler, no shared cluster for a later platform, and no `kubectl` path that can drift from the CDK source. That is acceptable here. The website is one task on purpose. Open WebUI's multi-copy mode expects Redis for websocket fan-out, and this demo does not run Redis. A second website task would be the wrong next step even on EKS. We would move to EKS if the workload had to join an existing Kubernetes platform, or if we needed a Kubernetes-only feature. How to add a second website task, and the other machinery left out of the demo, is in [ADR 0004](adr/0004-scope.md).

The load balancer and one NAT gateway sit in the public subnets. Open WebUI, github-mcp, oikb-daemon, and the one-shot tasks run in private subnets with no public IP. Their calls to OpenAI, GitHub, and the public image registries go out through that NAT gateway. Calls to S3 from those subnets use a gateway endpoint, including the stage bucket and the layers of images stored in this account. PostgreSQL runs in isolated subnets, with no route to the internet or to S3, and clients connect straight to it. There is no RDS Proxy pooling connections. ElastiCache, if added for a second website task, belongs in the isolated subnets. The rest of that list is in [ADR 0004](adr/0004-scope.md).

## Persistence across a new container

Fargate replaces the task disk when a task stops. The Open WebUI task definition mounts no volume. A restart, a deploy, or a crash leaves an empty container filesystem. Everything that must still be there lives outside the task.

RDS PostgreSQL 16 is that store for application data. The instance is single-AZ, encrypted, and `publiclyAccessible: false`. The database name is `openwebui`. Open WebUI receives `DATABASE_URL` from Secrets Manager. With that variable set, Open WebUI uses PostgreSQL for `users`, `chats`, `settings`, `knowledge-base` `records`, the `custom model`, and the `session` rows it keeps in its database. It does not use the SQLite file it would otherwise create under its data directory.

Sessions survive the new task for a second reason. `WEBUI_SECRET_KEY` is generated once per stage and kept in Secrets Manager. Open WebUI signs session cookies with that key. A new task reads the same key and the same database, so an existing login still validates. Replacing the key would sign everyone out, even with the database intact.

Two related stores sit beside that database:

- Embeddings use pgvector in the same instance. `VECTOR_DB=pgvector` and `PGVECTOR_DB_URL` is the same URL as `DATABASE_URL`. A one-shot task runs `CREATE EXTENSION IF NOT EXISTS vector` before Open WebUI migrates. `PGVECTOR_CREATE_EXTENSION` stays false on the service.
- File bytes use S3. `STORAGE_PROVIDER=s3`. The knowledge-base files copied from GitHub are objects in the stage bucket, not files on the container.

The Data stack owns the instance and the bucket. It does not import the website. The App stack adds the only database ingress rule: port 5432 from the application security group.

## After deploy

Orchestration listens for its own CloudFormation `CREATE_COMPLETE` and `UPDATE_COMPLETE`. The workflow creates the vector extension, runs the Open WebUI migration task, starts one website task, waits 30 seconds, runs bootstrap, starts one oikb-daemon task, and sends the ready email. The 30 seconds gives the website time to start before bootstrap calls it. If the website is not up by then, bootstrap keeps calling `/health/db` every 15 seconds, for up to 20 minutes. Bootstrap calls `/health/db` because the next step is to sign in and write the assistant. That needs the website to be answering, and it needs PostgreSQL to answer too. A 200 means both. The load balancer uses the same path. When the website answers, setup continues. If it never answers, bootstrap stops, the failure email goes out, and oikb-daemon is not started. The failure email carries the stage, the site URL, the time, the Step Functions error, and the log group names.

Bootstrap signs in, turns signup back on, stores an API key and the knowledge-base id, registers github-mcp, imports `oikb Ops Assistant`, and shares that assistant and the knowledge base with new accounts. It then syncs the repository once, waits until those files are processed, asks the six evaluation questions, and writes the report to S3. oikb-daemon then repeats the sync every 15 minutes. A sync error POSTs to notify-proxy, running on `127.0.0.1:8089` beside oikb-daemon. notify-proxy calls the notify Lambda. The alerts topic emails `SNS_EMAIL` and a Lambda posts the same subject and body to Slack. The webhook URL is `SLACK_WEBHOOK_URL` in `infra/.env`. See [ADR 0001](adr/0001-freshness.md), [ADR 0002](adr/0002-access-scope.md), and [ADR 0003](adr/0003-failure-detection.md).

The Monitoring stack is last. It only reads the earlier stacks. It emails the same SNS topic when the website, oikb-daemon, github-mcp, the database, the notify function, the Slack function, or the setup workflow is unhealthy, when a sync has been running for more than an hour, when the daemon task is up but has not reported its status for five minutes, and when the rate limit blocks a burst. That topic also posts the same note to Slack. Task alarms read `LiveTaskCount`. A missing value does not email. A reported count below 1 for 15 minutes does, which can happen during setup before the website or the daemon has been started; that mail says to wait for the ready email. The website health alarm emails when a task is live and failing its health check. The dashboard opens on the last three hours. The top numbers are healthy website tasks, the three task counts, minutes since the last sync, how long that sync took, files added, changed, and removed, and syncs succeeded and failed since the task started. The charts are requests (one page load is about 200), answers and errors with a zero line when nothing happened, request time in milliseconds, tasks, database CPU, connections, free disk on a scale of 0 to 20 GB, blocked requests, and whether a sync has run for more than an hour. A table lists finished syncs from the daemon log group: time, status, duration, files, and the error text. A monthly budget emails the same inbox at 80 percent and at 100 percent of `MONTHLY_BUDGET_USD`.

## Stacks

Dependencies run in one direction: Network, Data, App, Orchestration, Monitoring.

| Stack | Owns |
|---|---|
| Network | VPC in two AZs: public, private, and isolated subnets, one NAT gateway, S3 gateway endpoint on the private subnets |
| Data | PostgreSQL, the stage bucket, the database security group |
| App | Cluster, load balancer, access logs, public DNS name, private Cloud Map namespace, Open WebUI, github-mcp, github-mcp-proxy, oikb-daemon, the localhost signer, the sync metrics publisher, task definitions, SNS topic, notify Lambda, Slack Lambda |
| Orchestration | State machine and the rule that starts it |
| Monitoring | Alarms, plain-language alarm mail, dashboard, monthly budget, WAF rate limit |

## Monthly cost

One stage left running in `us-east-1` is about $170 a month before traffic. The table uses public list prices checked in November 2026 and a 730-hour month, rounded to the nearest dollar. Dev and prod are separate copies of this layout, so both stages together are about twice the table. Each stage file sets `MONTHLY_BUDGET_USD` to 200. That budget emails the stage inbox at $160 and at $200.

| Service (What Stays On)   | Size                                            | Cost |
| ------------------------- | ----------------------------------------------- | ---- |
| Fargate, Open WebUI       | 1 vCPU, 4 GB                                    | $43  |
| Fargate, GitHub MCP       | 0.5 vCPU, 1 GB                                  | $18  |
| Fargate, oikb daemon      | 0.5 vCPU, 1 GB                                  | $18  |
| NAT gateway               | one gateway, hourly charge                      | $33  |
| Public IPv4               | the NAT address and two load-balancer addresses | $11  |
| Application Load Balancer | hourly charge                                   | $16  |
| PostgreSQL                | `db.t3.micro`, single-AZ                        | $13  |
| Database Volume           | 20 GB gp3                                       | $2   |
| WAF                       | one web ACL and one rate rule                   | $6   |
| Secrets Manager           | 10 secrets                                      | $4   |
| CloudWatch dashboard      | one dashboard                                   | $3   |
| Standing total            |                                                 | $167 |

The rates behind those rows: Fargate Linux x86 is $0.04048 per vCPU-hour and $0.004445 per GB-hour. The NAT gateway is $0.045 per hour. Each in-use public IPv4 address is $0.005 per hour. The load balancer is $0.0225 per hour. PostgreSQL `db.t3.micro` is $0.018 per hour, and gp3 storage is $0.115 per GB-month. WAF is $5 for the web ACL and $1 for the rule. Each secret is $0.40 a month. The dashboard is $3 a month.

A quiet month adds a little above that $167. The NAT gateway also charges $0.045 for each gigabyte it processes: calls to OpenAI and GitHub, and pulls of the public images. Calls to S3 use the gateway endpoint, which has no hourly or per-gigabyte charge. The load balancer adds $0.008 per capacity-unit hour, a few dollars at demo traffic. Logs, the stage bucket, and the short-lived setup tasks stay small. The ten alarms sit inside the account's ten free standard alarms when that allowance is still open.

Chat and embeddings are an OpenAI bill on top of this AWS total. Bootstrap picks `gpt-5-mini`, `gpt-4.1-mini`, or `gpt-4o-mini`. Embeddings use `text-embedding-3-small` from the stage file.

Image pins, ports, and environment names are in the [reference](reference.md). The deploy steps are in [Deploy](deploy.md).
