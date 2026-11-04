# ADR 0002: Access scope

Status: accepted.

## Context

The assistant may look at GitHub for a known bug or a recent change. The same system must be unable to change a repository. Copying the knowledge base is a separate path: oikb reads the public project `open-webui/oikb` and writes only into Open WebUI.

## Options

Point Open WebUI at GitHub's hosted MCP endpoint, and store the token in the website.

Run the official MCP server ourselves with a token that can write, and trust the prompt not to call the write tools.

Run the official server as a private task, started read-only, with a token that can only read, and stop setup if a write tool is still listed.

## Decision

The GitHub helper cannot write, and the token never sits in the website.

It is a private Fargate service, not on the load balancer. Open WebUI reaches it at `http://github-mcp.chapters-<stage>.local:8082`. The image is `ghcr.io/github/github-mcp-server:v2.0.3`, a release that honors `--read-only` in HTTP mode. The command is `http --read-only --listen-host 127.0.0.1 --port 8083`, with `GITHUB_READ_ONLY=1`. That HTTP mode does not read the token from the environment. It expects `Authorization: Bearer` on each request. `containers/mcp-proxy` listens on port 8082 in the same task, adds that header from the secret, and forwards to `127.0.0.1:8083`. The token comes from `.env` through Secrets Manager and is injected only into that sidecar.

The token is fine-grained. Contents, Issues, and Pull requests are Read, and it can read public repositories. Bootstrap asks Open WebUI for the tool list and fails setup if the list is empty or any tool name looks like a write. Bootstrap and the daemon receive the same secret as `GITHUB_TOKEN`, so copying `open-webui/oikb` is not stopped by GitHub's limit of 60 anonymous requests per hour from the NAT address. The website task does not receive it.

## Trade-off

We run and pin another container so the token stays out of the website and so write tools are missing from the process, not merely discouraged. The hosted endpoint would be less to operate. An older image that ignored `--read-only` over HTTP would make that flag a false comfort, which is why the pin is `v2.0.3`.

Both controls have to stay in place. A read-only process with a token that can write, or a read-only token with a process that still offers write tools, is a failed setup. Bootstrap treats that as a setup failure.

## What would change this

Use a hosted read-only endpoint if that becomes the supported path and the token can stay out of the website. Widen the token only if the source repository becomes private and a read scope is no longer enough.
