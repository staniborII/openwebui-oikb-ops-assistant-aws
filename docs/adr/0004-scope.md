# ADR 0004: Scope

Status: accepted.

## Context

The time box is a few hours. The review needs a URL, a current library, read-only GitHub, sessions that survive a new task, and a failure email. Something else will not fit. The question is what to leave out, and why that rather than one of those five.

## Options

1. Drop HTTPS and serve the site on the load balancer's plain HTTP address.
2. Drop a second website task, Redis, Tika, a private copy of the official images in ECR, a push webhook, a grader that keeps scoring chats, or RDS Proxy.
3. Drop one of the five things the review asked for, and spend the time on the extras above.

Note:

Grader: A grader that keeps scoring chats is a job that would keep asking the six evaluation questions on a schedule and score the answers again. Bootstrap does that once, at setup, and saves the report in S3. A standing grader was left out.

Tika: It is Apache Tika, a separate service that pulls text out of documents. Open WebUI can send files to it. This project leaves it out because the Open WebUI image already extracts that text itself.

## Decision (option 2)

Leave out the extras. Keep the five things the review scores.

Left out: a second website task, Redis, Tika, an ECR copy of the images, a webhook, a grader that keeps running, and RDS Proxy. None of those is in the stacks.

Kept: 

- HTTPS on the stage hostname
- oikb-daemon syncing every 15 minutes
- a private read-only github-mcp
- PostgreSQL for accounts and chats, with the same WEBUI_SECRET_KEY, so a login survives a new website container (i.e. session persist container restarts)
- an email and a Slack note when the sync breaks

Long chats are part of the running behavior. The chat on screen stays complete. Bootstrap installs a filter on `oikb Ops Assistant` only. Before each model call it keeps the model request inside a cap that follows the selected model. `gpt-4o-mini` is 80,000 tokens, `gpt-5-mini` is 170,000, and `gpt-4.1-mini` is 650,000, estimated as characters divided by 4. An unknown model uses 80,000. The rules for what stays and what is left out are in the [overview](../overview.md). Open WebUI's context compaction stays off, because that feature summarizes older turns with another model call and is not a hard ceiling. Each evaluation question is a single turn, so this filter does not change its result.

Fargate rather than EKS, and PostgreSQL rather than a file on the task disk, are how the kept pieces run. They are described in the [architecture](../architecture.md).

## Trade-off

The site is one task, so it does not scale out. The library can be 15 minutes old. The grader runs once, during bootstrap. Nothing pools database connections. The official images are pulled from their public registries. Those are the costs of keeping the five things the review scores.

The chat on screen stays complete. Only the copy sent to the model is shortened when it gets too long. An older message is kept if it names the same thing as the new question: a file, an issue number, a real commit, or a connector id such as `github:open-webui/oikb`. Just saying "GitHub" is not enough, and a short random hex string is not treated as a commit. The last three exchanges are kept too. If that is still too much, the oldest of them is dropped, then the retrieved passages. If the question itself is too long, the model gets a note asking for a shorter one. Tokens are estimated as characters divided by 4, which can undercount, so the cap stays near five eighths of what the model accepts and leaves room for the reply: 80,000 for `gpt-4o-mini`, 170,000 for `gpt-5-mini`, and 650,000 for `gpt-4.1-mini`. An unknown model uses 80,000.

## What would change this

Add the piece whose absence is no longer acceptable.

- **A second website task.** One website task is enough for now. With more than one, the load balancer can send the person to a different task from the one holding their live chat, and that chat session is lost. To mitigate this, add ElastiCache for Redis in the isolated subnets and allow port 6379 from the application security group. On the Open WebUI task set `REDIS_URL` and `WEBSOCKET_MANAGER=redis`. Leave `UVICORN_WORKERS` at 1. After the migration task has succeeded, set the website desired count to 2 or higher. For a count that follows load, attach an ECS target-tracking policy with a minimum of 1, so the policy does not scale the service back to 0 while setup still owns the count. Set `minHealthyPercent` to 50. The load balancer already spreads requests. oikb-daemon stays one task. A second oikb-daemon would sync the same knowledge base twice.
- **Tika.** The Open WebUI image already extracts text itself. To use the separate extractor, run Apache Tika as a private Fargate service on Cloud Map (i.e. with a name only the website can reach inside the VPC), port 9998, with ingress only from the application security group. On the Open WebUI task set `CONTENT_EXTRACTION_ENGINE=tika` and `TIKA_SERVER_URL` to that Cloud Map address. Leave Tika off the load balancer.
- **A private copy of the official images.** The task start currently depends on the public registries. Copy Open WebUI, oikb, and github-mcp into ECR in `us-east-1` and point `OPEN_WEBUI_IMAGE`, `OIKB_IMAGE`, and `MCP_IMAGE` in the stage file at those URIs. Keep the same tags. The task execution role already pulls from ECR in this account.
- **A webhook.** This stays unavailable until we administer the source repository. See [ADR 0001](0001-freshness.md). If that changes, keep the 15-minute oikb-daemon so a missed hook still syncs.
- **A grader that keeps running.** Bootstrap asks the six questions once and saves the report in S3. To keep scoring, schedule the same six questions on EventBridge and write another object under `reports/<stage>/`. Pin the expected path fragments from a known-good report, the object `latest.json` names. A weak answer updates the report and leaves oikb-daemon running. See the [eval proposal](../eval-proposal.md).
- **RDS Proxy.** Add it when several website tasks would exhaust `max_connections`. Put the proxy in the isolated subnets. Allow port 5432 from the application security group to the proxy, and from the proxy to the instance. Point the URL writer at the proxy endpoint so `DATABASE_URL` and `PGVECTOR_DB_URL` use that host, with `sslmode=require` kept. Register the RDS master secret with the proxy. Then drop the direct task-to-instance rule. One website task with `UVICORN_WORKERS=1` stays under the `t3.micro` connection limit, so the proxy is idle cost until that second task exists.

Before the prod stage is a real environment, confirm the certificate in `infra/config.prod.yaml` is in `us-east-1` and covers `WEB_DOMAIN_NAME`, confirm `SNS_EMAIL`, and replace `ALLOWED_IPS: 0.0.0.0/0`. Dev has the same open allow-list. Prod already retains the database, the bucket, and the secrets, enables deletion protection, and keeps seven days of backups. Raise the database instance class when the `t3.micro` is the limit. Set `multiAz: true` when losing the single instance is no longer acceptable. That adds a standby. The application still has one `DATABASE_URL`. Confirm the SNS subscription from the prod inbox. Keep the website at one task until Redis is added too.
