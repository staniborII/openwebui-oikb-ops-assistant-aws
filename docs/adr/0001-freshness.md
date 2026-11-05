# ADR 0001: Freshness

Status: accepted.

## Context

The knowledge base should track `github.com/open-webui/oikb`. We had to decide how old that copy may be, what starts a sync, and where the sync runs.

## Options

1. A GitHub webhook on every push. The library would update within seconds of a commit.
2. A scheduler that starts a one-shot oikb container. Each run is independent. If it crashes, that shows up as an ECS task exit.
3. oikb-daemon. One long-running task, syncing on its own timer.

## Decision (option 3)

Fifteen minutes is fresh enough. oikb-daemon's own timer is what starts a sync, and the sync runs in its own Fargate task, not inside the website.

`containers/oikb/.oikb.yaml` sets `interval: 15m`. The task writes into Open WebUI at the private Cloud Map name. Bootstrap runs one sync during setup, after the website is up. oikb-daemon stays at zero tasks until that setup exits 0. The workflow then sets the count to 1, and oikb-daemon repeats the sync every 15 minutes.

A webhook cannot be the trigger for this repository. oikb only listens for `POST /webhooks/github`. It does not create the hook. GitHub sends a repository webhook only to an owner or an admin, and this project does not administer `open-webui/oikb`. The token can read Contents, Issues, and Pull requests. It cannot add a hook. oikb-daemon is also private, so a hook would have nowhere to land. The missing permission is enough on its own.

## Trade-off

The library can lag `main` by 15 minutes. That is the bound we can actually meet. Asking GitHub whether a public repository changed, and finding that it has not, is cheap. That is what oikb-daemon does between real commits.

## What would change this

A webhook becomes possible when an owner or an admin of `open-webui/oikb` adds it. The read token already in this deployment downloads the files. It cannot create the hook, and the admin does not hand over a personal access token. To have configure the webhook:

1. This deployment will need to add a public Lambda function URL which GitHub can reach. Tghe oikb-daemon has no public address, and the load balancer forwards only to Open WebUI.
2. The admin of the oikb Git repo adds the webhook in the repository settings: on a push, GitHub POSTs to that URL. They set a shared secret on the hook, and this deployment stores the same secret.
3. Someone pushes to the repository. GitHub POSTs the event to the Lambda.
4. The Lambda checks `X-Hub-Signature-256` with the shared secret, then tells oikb-daemon to sync.
5. oikb-daemon reads the repository with the existing read token and writes the changed files into the knowledge base.
6. The 15-minute timer stays. A missed hook still syncs on the next run.

Until we administer the repository, a fresher copy means checking the latest commit with the read token and syncing only when that commit changes. That uses a permission we already have.
