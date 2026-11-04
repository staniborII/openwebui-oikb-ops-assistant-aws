# Architecture

The short tour of the whole system is the [overview](overview.md). This page is the closer look at the request path, the network, and where data lives.

Open WebUI is the website. oikb keeps a knowledge base in that website aligned with the public repository `github.com/open-webui/oikb`. The saved assistant `oikb Ops Assistant` answers from that library and can call a private, read-only GitHub MCP server when a question needs a live look at issues or recent changes. CDK in `infra/` is the description AWS builds from. `cdk deploy --all` returns before the assistant exists. EventBridge then starts a Step Functions workflow in the same account. The ready email is the signal that the site can be sent to someone else.

The task's four decisions are the [decision record](decision-record.md) and the [ADRs](adr/0001-freshness.md). Compute and where data lives are described in this page.

## Request path

```text
Browser
  -> https://<WEB_DOMAIN_NAME>          ALLOWED_IPS; both stage files currently allow 0.0.0.0/0
    -> WAF                              2000 requests per five minutes per address
      -> Application Load Balancer      HTTP redirects to HTTPS, access logs kept 14 days
        -> Open WebUI, one Fargate task port 8080
             RDS PostgreSQL             accounts, chats, sessions, assistant, vectors
             S3                         file bytes of the synced repository

Open WebUI
  -> GitHub MCP, one private Fargate task    Cloud Map, port 8082, not on the load balancer

oikb daemon, one Fargate task, started after bootstrap
  -> reads github.com/open-webui/oikb
  -> writes into the Open WebUI knowledge base
  -> on sync error, POSTs to 127.0.0.1:8089 in the same task
       that signer calls the notify function URL with the daemon task role
       the function publishes to SNS
  -> once a minute, the same task reads 127.0.0.1:8080/metrics
       and publishes the change to CloudWatch namespace Chapters/Oikb
```

The App stack creates a private Cloud Map namespace `chapters-<stage>.local` in the VPC. Those names resolve only inside the VPC. Bootstrap and the daemon call `http://web.chapters-<stage>.local:8080` and `http://github-mcp.chapters-<stage>.local:8082`. They do not use the public load balancer. The load balancer only accepts `ALLOWED_IPS`. The tasks have no public IP, so a callback from the internet has no path to them. Port 8082 is a sidecar in the MCP task. It adds the GitHub token and forwards to the MCP process on `127.0.0.1:8083`.

## Compute

The workloads run as ECS Fargate services and one-shot tasks in `us-east-1`. There is no Kubernetes control plane.

EKS was the other serious option. It would give a cluster API, Deployments, and a place to add later services with the same tooling. This demo is three long-running tasks (the website, the MCP server, the daemon) plus short-lived migration, vector, and bootstrap tasks. An EKS control plane would be a second system to pay for, upgrade, and explain, beside a CDK app that already states the task definitions. Fargate starts those tasks from the task definition. There are no nodes to patch.

The trade-off is the Kubernetes feature set. There is no Horizontal Pod Autoscaler, no shared cluster for a later platform, and no `kubectl` path that can drift from the CDK source. That is acceptable here. The website is one task on purpose. Open WebUI's multi-copy mode expects Redis for websocket fan-out, and this demo does not run Redis. A second website task would be the wrong next step even on EKS. We would move to EKS if the workload had to join an existing Kubernetes platform, or if we needed a Kubernetes-only feature. How to add a second website task, and the other machinery left out of the demo, is in [ADR 0004](adr/0004-scope.md).

The load balancer and one NAT gateway sit in the public subnets. Open WebUI, the MCP server, the daemon, and the one-shot tasks run in private subnets with no public IP. Their calls to OpenAI, GitHub, and the public image registries go out through that NAT gateway. Calls to S3 from those subnets use a gateway endpoint, including the stage bucket and the layers of images stored in this account. PostgreSQL runs in isolated subnets, with no route to the internet or to S3, and clients connect straight to it. There is no RDS Proxy pooling connections. ElastiCache, if added for a second website task, belongs in the isolated subnets. The rest of that list is in [ADR 0004](adr/0004-scope.md).

## Persistence across a new container

Fargate replaces the task disk when a task stops. The Open WebUI task definition mounts no volume. A restart, a deploy, or a crash leaves an empty container filesystem. Everything that must still be there lives outside the task.

RDS PostgreSQL 16 is that store for application data. The instance is single-AZ, encrypted, and `publiclyAccessible: false`. The database name is `openwebui`. Open WebUI receives `DATABASE_URL` from Secrets Manager. With that variable set, Open WebUI uses PostgreSQL for users, chats, settings, knowledge-base records, the custom model, and the session rows it keeps in its database. It does not use the SQLite file it would otherwise create under its data directory.

Sessions survive the new task for a second reason. `WEBUI_SECRET_KEY` is generated once per stage and kept in Secrets Manager. Open WebUI signs session cookies with that key. A new task reads the same key and the same database, so an existing login still validates. Replacing the key would sign everyone out, even with the database intact.

Two related stores sit beside that database:

- Embeddings use pgvector in the same instance. `VECTOR_DB=pgvector` and `PGVECTOR_DB_URL` is the same URL as `DATABASE_URL`. A one-shot task runs `CREATE EXTENSION IF NOT EXISTS vector` before Open WebUI migrates. `PGVECTOR_CREATE_EXTENSION` stays false on the service.
- File bytes use S3. `STORAGE_PROVIDER=s3`. The knowledge-base files copied from GitHub are objects in the stage bucket, not files on the container.

The Data stack owns the instance and the bucket. It does not import the website. The App stack adds the only database ingress rule: port 5432 from the application security group.

## After deploy

Orchestration listens for its own CloudFormation `CREATE_COMPLETE` and `UPDATE_COMPLETE`. The workflow creates the vector extension, runs the Open WebUI migration task, starts one website task, waits 30 seconds, runs bootstrap, starts one daemon task, and sends the ready email. Bootstrap is what polls `/health/db`, for up to 20 minutes. The failure email carries the stage, the site URL, the time, the Step Functions error, and the log group names. The daemon is not started when setup failed.

Bootstrap signs in, stores an API key and the knowledge-base id, registers the MCP server, imports `oikb Ops Assistant`, syncs the repository once, waits until those files are processed, asks the three evaluation questions, and writes the report to S3. The daemon then repeats the sync every 15 minutes. A sync error POSTs to the signer beside the daemon, which calls the notify Lambda. See [ADR 0001](adr/0001-freshness.md), [ADR 0002](adr/0002-access-scope.md), and [ADR 0003](adr/0003-failure-detection.md).

The Monitoring stack is last. It only reads the earlier stacks. It emails the same SNS topic when the website, the daemon, the GitHub helper, the database, the notify function, or the setup workflow is unhealthy, and when the rate limit blocks a burst. It does not email while the website or the daemon is still at zero tasks. The dashboard shows visitors, site errors, request time, running tasks, database CPU, connections, free disk, blocked requests, and the sync counts the daemon task publishes to CloudWatch (`Chapters/Oikb`: succeeded, partial, and failed syncs, files uploaded and deleted, and sync duration). A monthly budget emails the same inbox at 80 percent and at 100 percent of `MONTHLY_BUDGET_USD`.

## Stacks

Dependencies run in one direction: Network, Data, App, Orchestration, Monitoring.

| Stack | Owns |
|---|---|
| Network | VPC in two AZs: public, private, and isolated subnets, one NAT gateway, S3 gateway endpoint on the private subnets |
| Data | PostgreSQL, the stage bucket, the database security group |
| App | Cluster, load balancer, access logs, public DNS name, private Cloud Map namespace, Open WebUI, MCP, daemon, the localhost signer, the sync metrics publisher, task definitions, SNS topic, notify Lambda |
| Orchestration | State machine and the rule that starts it |
| Monitoring | Alarms, plain-language alarm mail, dashboard, monthly budget, WAF rate limit |

Image pins, ports, and environment names are in the [reference](reference.md). The deploy steps are in [Deploy](deploy.md).
