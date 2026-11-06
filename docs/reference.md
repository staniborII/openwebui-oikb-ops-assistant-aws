# Reference

Region `us-east-1`. Stage files: `infra/config.dev.yaml`, `infra/config.prod.yaml`. Names go through `stagified` in `infra/utils/index.ts`.

## Stacks

| Order | Stack | Physical name |
|---|---|---|
| 1 | Network | `chapters-network-<stage>` |
| 2 | Data | `chapters-data-<stage>` |
| 3 | App | `chapters-app-<stage>` |
| 4 | Orchestration | `chapters-orchestration-<stage>` |
| 5 | Monitoring | `chapters-monitoring-<stage>` |

Data does not import App. The database ingress rule is created in App. Monitoring reads the earlier stacks.

## Images

| Workload | Image | Command |
|---|---|---|
| Open WebUI | `ghcr.io/open-webui/open-webui:v0.13.0` | image entrypoint; migration task runs `python -c "import open_webui.config"` |
| oikb-daemon | `ghcr.io/open-webui/oikb:0.6.0` | `daemon --config /config/.oikb.yaml`. `containers/sync-metrics` in the same task reads `GET /metrics` and `GET /health`, and publishes the current totals and the latest sync to CloudWatch namespace `Chapters/Oikb`. `SyncRunningTooLong` is 1 when a source has been `running` for an hour. `SyncReport` is 1 when `/health` was read. Each minute it logs `sync-status` to `/chapters/<stage>/daemon`, and `sync-history` when a sync finishes. The dashboard table shows the history line: status, duration, files, and error |
| github-mcp | `ghcr.io/github/github-mcp-server:v2.0.3` | `http --read-only --listen-host 127.0.0.1 --port 8083`. `containers/github-mcp-proxy` listens on 8082 and adds the bearer token |
| Vector extension | `public.ecr.aws/docker/library/postgres:16` | `psql` `CREATE EXTENSION IF NOT EXISTS vector` |
| Bootstrap | built from `containers/bootstrap` | `python -m bootstrap.run` |

## Ports

| Listener | Port | Who can connect |
|---|---|---|
| Load balancer | 80, 443 | `ALLOWED_IPS` in the stage file. Port 80 redirects to 443 |
| Open WebUI | 8080 | Load balancer security group, and the application security group itself |
| github-mcp-proxy | 8082 | Application security group. github-mcp listens on `127.0.0.1:8083` inside the task |
| PostgreSQL | 5432 | Application security group, rule owned by App |

Inside the oikb-daemon task, the signer listens on `127.0.0.1:8089` and the metrics reader on `127.0.0.1:8091`. Neither port is published on the task. Private Cloud Map namespace, VPC only: `chapters-<stage>.local`. Records: `web` port 8080, `github-mcp` port 8082. Both stage files set `ALLOWED_IPS` to `0.0.0.0/0`.

## Where data lives

| Data | Store | Survives a new Open WebUI task |
|---|---|---|
| Users, chats, settings, knowledge-base rows, assistant, session rows | RDS PostgreSQL 16, database `openwebui` | Yes. `DATABASE_URL` |
| Session cookie signature | `WEBUI_SECRET_KEY` in Secrets Manager | Yes. The key is generated once per stage |
| Embeddings | pgvector in that database | Yes. `PGVECTOR_DB_URL` is the same URL |
| Synced file bytes | Stage S3 bucket | Yes. `STORAGE_PROVIDER=s3` |
| Container filesystem | Fargate task disk, no volume mounted | No |

The instance is a `t3.micro` with 20 GB, single-AZ, encrypted, and not publicly accessible. It sits in the isolated subnets. Clients use `DATABASE_URL` against the instance. There is no RDS Proxy. Prod retains the instance, the bucket, and the secrets, enables deletion protection, and keeps 7 days of backups. Dev destroys them and keeps 1 day of backups. How to add the proxy and the rest of a prod layout is in [ADR 0004](adr/0004-scope.md).

## Plain environment on Open WebUI

`HOST` `0.0.0.0`, `PORT` `8080`, `UVICORN_WORKERS` `1`, `WEBUI_URL` `https://` plus `WEB_DOMAIN_NAME`, `CORS_ALLOW_ORIGIN` the same address, `ENABLE_DB_MIGRATIONS` `false` on the service and `true` on the migration task, `ENABLE_OLLAMA_API` `false`, `ENABLE_API_KEYS` `true`, `ENABLE_SIGNUP` and `DEFAULT_USER_ROLE` from `infra/.env`, `VECTOR_DB` `pgvector`, `PGVECTOR_CREATE_EXTENSION` `false`, `RAG_EMBEDDING_ENGINE` `openai`, `RAG_EMBEDDING_MODEL` from the stage file, `RAG_SOURCE_METADATA_KEYS` `source`, `STORAGE_PROVIDER` `s3`, `S3_BUCKET_NAME`, `S3_REGION_NAME` `us-east-1`.

`RAG_SOURCE_METADATA_KEYS` is `source`. Open WebUI then puts the uploaded file name on each retrieved passage. The passage's name attribute stays the knowledge collection. The assistant filter copies that file name onto a `File:` line at the start of the passage.

`CORS_ALLOW_ORIGIN` replaces the image default `*`. With `*`, any other website can call this API from a visitor's browser and use that visitor's login. The value here is the public site address, so only that origin is allowed. Opening the site in a browser is unchanged, because the page and the API are that same address. Setup and the sync job call the API from inside the VPC, and those calls do not use CORS.

`WEBSOCKET_MANAGER`, Redis variables, Tika variables, and `LICENSE_KEY` are unset. Context compaction stays off. Bootstrap installs the filter `oikb_context_budget` on the assistant `oikb-ops-assistant` only. The cap is 80,000 tokens for `gpt-4o-mini`, 170,000 for `gpt-5-mini`, and 650,000 for `gpt-4.1-mini`. An unknown model uses 80,000. An older turn is kept for a connector when it names a connector id, such as `github:open-webui/oikb`. The three preceding exchanges can be left out when the request is still over the cap. A question that is still over the cap is sent without its retrieved passages, or as a short note when the person's own words do not fit. How to set Redis or Tika is in [ADR 0004](adr/0004-scope.md).

## Secrets injected at start

| Name | Source |
|---|---|
| `WEBUI_SECRET_KEY` | Generated in the App stack |
| `DATABASE_URL`, `PGVECTOR_DB_URL` | URL secret written from the RDS master secret |
| `OPENAI_API_KEY`, `RAG_OPENAI_API_KEY` | `infra/.env`, or the environment running the deploy |
| `WEBUI_ADMIN_EMAIL`, `WEBUI_ADMIN_PASSWORD` | `infra/.env`, or the environment running the deploy. Applied when the database has no users |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | `infra/.env`, or the environment running the deploy. github-mcp-proxy only |
| `GITHUB_TOKEN` | The same secret. Bootstrap and oikb-daemon, so the public repository sync is authenticated |

The Open WebUI API key and the knowledge-base id start as `pending`. Bootstrap replaces them. oikb-daemon reads those two plus the generated oikb API password. The website task does not receive the GitHub token. The migration task receives the signing key and the database URL, not the admin password or the OpenAI key. `SLACK_WEBHOOK_URL` is stored in Secrets Manager and read by the alerts Lambda. It is not passed to a container.
