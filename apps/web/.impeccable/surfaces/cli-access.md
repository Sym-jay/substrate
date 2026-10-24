# CLI access

Mode: Operate. Ordinary extension of the deployed dashboard, based on `deploy/agent-workflows-dashboard` at `9c8521d`.

The user asked to build the CLI and confirmed workspace management plus tasks and comparisons as the first priority. A working user-facing CLI needs persistent identity without AWS access; this extension adds browser approval and revocation, using the existing Clerk sign-in and owner permissions.

Inherit the incumbent graphite/platinum and light themes in `src/app/theme.css`, system sans typography, existing Card and Button components, and Settings composition. No visual-system replacement is requested. The authorization URL is a narrow, purpose-defined flow: preview device name, compare an eight-character code with the CLI, understand account access and expiry, then explicitly approve or decline. Merely opening the URL or signing in never grants access. Settings lists active CLI sessions and exposes revocation. Never display the bearer credential in the browser.

Required states: pending/loading, approved, declined, expired/unavailable request, saving, active sessions, empty sessions, revoked, and retryable request failure. Code is monospace for comparison; ordinary explanatory text stays system sans. Full account permissions, 30-day credential expiry, and Settings revocation are stated clearly. Device names are untrusted text rendered safely.

Verify at 1440 px desktop and 390 px mobile, with both incumbent themes. Browser fixtures use mock browser identities and an isolated local control/guest setup; they do not establish a real Clerk sign-in or AWS acceptance result. No comp or new design system files are required for this narrow extension.

## Implementation and review evidence

`src/cli/CliAccess.tsx` implements explicit approval/decline and the Settings session list; `App.tsx`, `ClerkApp.tsx`, `app/router.ts`, and `pages/SettingsPage.tsx` connect those surfaces to the existing app. The implementation reuses `app/ui.tsx` Card/Button variants and `app/theme.css` graphite/platinum and light treatments. Global tokens are unchanged. The constrained authorization card, wrapping device names and action row, and existing Settings column preserve the incumbent hierarchy at desktop and mobile widths.

Rendered evidence is in `.impeccable/review/cli/`: `authorize-desktop.png`, `authorize-mobile.png`, `authorize-light.png`, `approved-mobile.png`, `settings-desktop.png`, `settings-mobile.png`, `settings-light.png`, `declined-mobile.png`, `unavailable-mobile.png`, and `retry-mobile.png`. All ten captures were opened and validated. Settings full-page captures use a scratch-only guard to hide closed sheets; that preexisting capture/layout issue was not repaired and visible UI was unchanged.

The review's sole initial finding was the missing retry for an initial request failure. The corrected state offers “Try again” for network, server, and rate-limit failures and retries only the preview GET; unavailable requests still instruct the user to rerun login. The reviewer accepted that correction with a ship verdict limited to the reported fix scope.

Validation supplied for this implementation: 156 tests, typecheck, and web build passed; the macOS ARM binary executed and Linux x64 cross-compilation succeeded. Browser validation used mock identity and a local API with real isolated shell tasks. Live Clerk authentication and AWS behavior remain unverified by this evidence.


## Current-main integration (2026-10-24)

CLI access now inherits `main` at `0fded18`: the light monospace/ASCII dashboard,
its shared Card/Button components and current Settings/account panels. The prior
graphite/platinum evidence above documents the initial release; it is not the
visual authority for this integration. No global tokens or dashboard layout changed.
The approval action uses the incumbent primary button, and the brand link goes
to the current welcome route. Account, SSH, agent keys, GitHub and usage remain.

Current local captures are under `.impeccable/review/phase2-cli/`: approval at
1440/390 px, approved mobile, and Settings at both sizes. Native browser input
verified explicit approval against real local API routes. No horizontal overflow
was detected. Mock identity is used; this is not evidence of real Clerk login.
The manual Impeccable detector returned no findings. Closed incumbent launch
sheets are hidden only for full-page capture, as in the original review.
