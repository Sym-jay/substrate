# Substrate

Give your agent a computer it’s allowed to wreck.

Substrate runs each workspace in its own Firecracker microVM on AWS. You can start Claude Code, Codex, or any other agent in it, then open the same session from a laptop, tablet, or phone.

> **Status:** M0 (AWS infrastructure) in progress.

## What it does

- **Three ways to start a VM**
  - **From GitHub:** connect your account, import a repo, and start an agent on it.
  - **Blank:** start an agent right away in an empty workspace.
  - **Terminal only:** a plain shell for testing custom tools or your own agents.
- **Persistent:** the disk and agent sessions survive disconnects, sleep, and restarts.
- **Sizes:** the default is 6 vCPU and 16 GB RAM, enough for Claude Code and its tooling. You can choose a smaller size for lighter work.
- **Environments:** Linux by default. macOS and Windows are planned.
- **Any device:** a web UI that works well on phones and tablets, plus SSH.

## Architecture (planned)

```
Browser / mobile / CLI
        │
   Control plane (API, auth, scheduling, billing)
        │
   EC2 hosts (host daemon) ──► Firecracker microVMs (one per workspace)
```

## Stack

- **Frontend:** Vite + React + Tailwind CSS
- **Backend and agents:** TypeScript on Bun (Hono API, host daemon, in-VM agent)
- **Infrastructure:** AWS CDK in `ap-south-1`, one control box plus an `r8i.4xlarge` microVM host

The full plan and milestones are in [docs/plan.md](docs/plan.md).

## Developing

See [docs/development.md](docs/development.md) to run it locally and work with the AWS deployment.

## CLI (in development)

`bun run cli --help` lists the workspace, task, and comparison commands.
`bun run cli:build` creates a standalone executable. Browser-approved CLI login
is enabled on the deployed control service. See [docs/cli.md](docs/cli.md)
for installation, authentication, examples, and validation limits.
