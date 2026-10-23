# Substrate

Persistent sandboxes for long-running coding agents.

Substrate runs each workspace in its own Firecracker microVM on AWS. You can start Claude Code, Codex, or any other agent in it, then open the same session from a laptop, tablet, or phone.

> **Status:** planning. There's no code yet.

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
- **Everything else:** to be decided
