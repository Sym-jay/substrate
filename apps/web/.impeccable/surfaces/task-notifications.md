# Task notifications

Mode: Operate. Ordinary extension of the incumbent `main` dashboard at `546c217`.

The user requested per-user task notifications and chose Telegram. The Settings section lets an account owner connect a private chat, choose task outcomes, send a test, inspect delivery status, and disconnect. It works with the existing task inbox; saved results remain available there when Telegram is unavailable.

## Incumbent system and composition

The visual authority is the light dashboard in `src/app/theme.css`, `src/index.css`, and `src/app/ui.tsx`: white paper, dark monospace text, Geist Pixel page headings, hairline borders, square corners, and blue selection/focus/primary actions with the existing ASCII motion vocabulary. The notification extension introduces no tokens, typography, component variants, or global motion rules.

`src/pages/SettingsPage.tsx` places one **Task notifications** Card immediately after **App connectors**. The existing Settings page header, card column, navigation, and subsequent account-access sections retain their composition. `src/account/TaskNotifications.tsx` reuses the shared Card, Button, and FieldRow components and the existing settings-row layout. Its card heading is the established compact uppercase monospace section title; explanatory text and state messages follow the incumbent small body/helper hierarchy. The explicit browser confirmation uses the existing blue primary button; other actions use existing secondary or ghost buttons.

The existing page-body spacing and width govern the section. Settings rows retain their two-column desktop layout and stack below the incumbent 640 px breakpoint. Action groups wrap; chat labels can break across lines. Preference labels and their native checkboxes form one interactive label, with a 44 px minimum control wrapper. This is a task-specific use of the existing interface, not a new visual world or global rulebook.

## Interaction and state contract

- **Private connection:** Connect Telegram creates a ten-minute Start link. Open Telegram, press Start in the private chat, then return to the signed-in browser. A callback proposes the chat identity; the owner explicitly chooses **Confirm Telegram connection** before it becomes the destination. Pending links can be replaced, and expired links offer reconnection. Group chats are unsupported.
- **Account preferences:** Receive task alerts gates the three categories: Task finished, Task failed, and Needs attention. Preferences persist on the account and operate after the tab closes. Controls are disabled when disconnected, unavailable, saving, or gated by the master preference.
- **Delivery:** Send test queues a notification. The section distinguishes queued/sending, delivered, failed, and skipped states; queued work is not presented as successful delivery. Retryable transport problems, Telegram refusal, and unavailable settings have explanatory text and appropriate recovery actions.
- **Disconnect:** Disconnect clears the destination and cancels queued deliveries. The disclosure explains that a message already being sent may still arrive. Cancelled tasks do not send alerts.
- **Unconfigured server:** Explain that Telegram is not enabled, disable connection-dependent controls, and keep the inbox available. Alerts disclose that task names and links are sent; prompts and terminal output remain in Substrate.

`src/account/api.ts` uses owner-authenticated local routes and `packages/protocol/src/notifications.ts` defines the preferences, pending connection, availability, and delivery states. The control-service implementation and operator setup are documented in `../../../../docs/task-notifications.md`.

## Implementation and review evidence

Seven validated captures are recorded in `../review/task-notifications/`: `connected-desktop.png`, `connected-mobile.png`, `pending-desktop.png`, `pending-mobile.png`, `confirm-mobile.png`, `unconfigured-desktop.png`, and `unconfigured-mobile.png`. Validation used 1440 px desktop and 390 px mobile widths with no horizontal overflow. The final connected mobile full-page capture is 2537 px tall; the earlier screenshot-only blank tail was corrected without changing product layout.

The independent finish reviewer returned **ship**, completed all five review sections, and reported no material fixes. The minor relative-time grammar correction was applied and re-reviewed. The mechanical detector result at `/private/tmp/substrate-notifications-detector.json` is `[]`.

Implementation validation reports 222 passing tests and one platform-specific skip, 24 passing real local Postgres tests, and passing typecheck and production web build. Browser evidence uses mock account identity and mock Telegram transport with real local routes, database, queue, and shell-task execution. Native browser input exercised connect, explicit confirmation, test, and disconnect. These results do not establish real Clerk sign-in, BotFather setup, or real Telegram delivery. The server has no Telegram parameters configured; an authorized operator must configure the dedicated bot before live delivery can be verified.

This documentation pass checked the implementation, shared theme/primitives, API/protocol, existing surface briefs, and product context. It preserves `PRODUCT.md`, all global design/token files, and other surface briefs. Older briefs contain historical typography/theme guidance superseded by the current light monospace dashboard; that pre-existing documentation drift is neither promoted into this surface nor repaired here. No `DESIGN.md` or `.impeccable/design.json` is introduced for this ordinary extension.
