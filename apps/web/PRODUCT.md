# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Developers and small technical teams running persistent coding agents. The broader product is intended to support personal and business agents too.

## Product Purpose
Substrate runs isolated Linux workspaces with persistent files, processes, and terminals. Users can disconnect and return from another device, deliberately pause/resume, and fork running state.

## Operating Context
An existing Bun/React application on a shared AWS sandbox host. Existing workspace management and terminals remain available. This extension adds an owner-scoped task/results inbox and comparisons of two approaches from the same saved environment. The user confirmed tasks should support both agent prompts and shell commands and that the current interface style should be preserved. The CLI exposes workspace management, tasks, and comparisons; the browser provides explicit login approval and Settings session revocation within the existing interface.

## Capabilities and Constraints
Use real task status, output, exit codes, and optional verification commands. Do not invent successful test results or summaries. Persist tasks and comparisons across browser/control restarts. Preserve per-user VM ownership and quotas. A paused process does not progress. VM forks copy running services and files; they do not merge agent reasoning. Agent-provider credentials remain inside the user's workspace. CLI account credentials are separate, issued after explicit browser approval and revocable in Settings.

## Evidence on Hand
Repository plan and milestone acceptance reports in ../../docs. Existing workspace implementation is the visual authority. No new customer, scale, or pricing claims are authorized.

## Product Principles
- Make the work, its results, and next action understandable.
- Preserve the existing workspace and terminal workflows.
- Explain preparation failures and interrupted tasks honestly.
- Compare evidence and let the owner choose which approach to continue.
