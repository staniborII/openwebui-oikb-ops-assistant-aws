# ADR 0001: Freshness

Status: accepted.

## Context

The knowledge base should track `github.com/open-webui/oikb`. We had to decide how old that copy may be, what starts a sync, and where the sync runs.

## Options

A GitHub webhook on every push. The library would update within seconds of a commit.

A scheduler that starts a one-shot oikb container. Each run is independent. If it crashes, that shows up as an ECS task exit.

The official oikb daemon. One long-running task, syncing on its own timer.

## Decision

Fifteen minutes is fresh enough. The daemon's own timer is what starts a sync, and the sync runs in its own Fargate task, not inside the website.

`containers/oikb/.oikb.yaml` sets `interval: 15m`. The task writes into Open WebUI at the private Cloud Map name. Bootstrap runs one sync during setup, after the website is up. The daemon stays at zero tasks until that setup exits 0. The workflow then sets the count to 1, and the daemon repeats the sync every 15 minutes.

A webhook cannot be the trigger for this repository. oikb only listens for `POST /webhooks/github`. It does not create the hook. GitHub sends a repository webhook only to an owner or an admin, and this project does not administer `open-webui/oikb`. The token can read Contents, Issues, and Pull requests. It cannot add a hook. The daemon is also private, so a hook would have nowhere to land. The missing permission is enough on its own.

## Trade-off

The library can lag `main` by 15 minutes. That is the bound we can actually meet. Asking GitHub whether a public repository changed, and finding that it has not, is cheap. That is what the daemon does between real commits.

## What would change this

A webhook becomes possible only if we administer the source repository. The receiver would be a public Lambda function URL. It would check `X-Hub-Signature-256` and then ask the daemon to sync. That route stays off the load balancer, because GitHub is not in `ALLOWED_IPS`. The 15-minute daemon stays, so a missed hook still syncs.

Until we administer the repository, a fresher copy means checking the latest commit with the read token and syncing only when that commit changes. That uses a permission we already have.
