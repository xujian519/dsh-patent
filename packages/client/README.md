---
description: "Package map for the web GUI browser half: shell boot, browser-host communication, shared client services, localization, development reload, and the UI feature plugins."
kind: "package-group"
---

# client/ — web-GUI browser half

English | [中文](README.zh.md)

## Summary

The `client/` group provides the browser experience for the dsh web GUI, including conversation, navigation, settings, approvals, file access, and other interactive features. Choose packages from this family when adding browser-visible behavior; use [`host/`](../host/README.md) for server-side page delivery and host integration. Packages cover both the shared browser foundation and focused UI features, while each child README owns its configuration and behavior. Authoring rules live in [AGENTS.md](AGENTS.md), and the related documentation below explains cross-package composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The kernel packages boot and serve the page; the UI feature packages present it. Each package README owns its contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Boots the browser shell | — |
| [`modules/`](modules/README.md) | Loads browser-side client modules | `ctx.clientModules` / `ctx.modules` |
| [`config/`](config/README.md) | Declares the types a browser plugin uses to read its live Host configuration | `ctx.config` |
| [`connection/`](connection/README.md) | Maintains browser-host RPC communication and event delivery | `ctx.connection` |
| [`remote-connection/`](remote-connection/README.md) | Signs another browser into the same Host through QR login, credential links, and owner-approved pairing | `ctx.remoteConnection` |
| [`file-upload/`](file-upload/README.md) | Sends raw Blob and byte-stream request bodies outside the page thread | `ctx.fileUpload` |
| [`shortcuts/`](shortcuts/README.md) | Registers application keyboard commands | `ctx.shortcuts` |
| [`ui-shortcuts/`](ui-shortcuts/README.md) | Presents the keyboard shortcut reference | — |
| [`store/`](store/README.md) | Provides React-free observable and snapshot-store primitives | — |
| [`hmr/`](hmr/README.md) | Refreshes client plugins during development | — |
| [`script-realm/`](script-realm/README.md) | Registers optional script-environment providers and creates caller-owned Realm instances | `ctx.scriptRealms` |
| [`script-realm-iframe/`](script-realm-iframe/README.md) | Provides an optional same-origin iframe script environment through the Realm registry | — |
| [`locale/`](locale/README.md) | Provides localization preferences and message dictionaries | `ctx.locale` |
| [`product-analytics/`](product-analytics/README.md) | Reports selected Desktop product events through the Host OTLP exporter | `ctx.productAnalytics` |
| [`test-runtime/`](../test-support/client-runtime/README.md) | Shared repository test support for client feature packages | — |
| [`ui-renderer/`](ui-renderer/README.md) | Binds slot data to React and mounts the assembled application | `ctx.uiRenderer` |
| [`ui-slots/`](ui-slots/README.md) | Defines typed extension Slots and reusable Component Factories | — |
| [`ui-session/`](ui-session/README.md) | Adapts Session Controller state into standard Slot sources and hooks | — |
| [`ui-session-status/`](ui-session-status/README.md) | Keeps reading reminders in Host memory and combines running state, the effective pending interaction, and shared reminders into the Session status table behind `useSessionStatus` | `ctx.sessionStatus` / `ctx.uiSession.sessionStatus` |
| [`ui-theme/`](ui-theme/README.md) | Applies the selected color theme | — |
| [`ui-primitives/`](ui-primitives/README.md) | Provides shared React controls, icons, and content renderers | — |
| [`ui-attachment/`](ui-attachment/README.md) | Registers composer and message-image attachment presentation | — |
| [`ui-layout/`](ui-layout/README.md) | Arranges the main application regions | — |
| [`ui-sidebar/`](ui-sidebar/README.md) | Presents workspace and session navigation | — |
| [`ui-sidebar-browser/`](ui-sidebar-browser/README.md) | Browses sandboxed HTTP(S) pages, including loopback services, in right-Sidebar tabs | — |
| [`resources/`](resources/README.md) | Unified resource model: protocol providers behind the `useResource` session standard hook | `ctx.resources` |
| [`ui-sidebar-files/`](ui-sidebar-files/README.md) | The workspace files page and one workspace tree per pane beside docked and floating previews | — |
| [`ui-sidebar-documentpreview/`](ui-sidebar-documentpreview/README.md) | Previews readable files in the right Sidebar under the `text` tab kind | `ctx.documentPreviews` |
| [`ui-sidebar-terminal/`](ui-sidebar-terminal/README.md) | Right-Sidebar interactive shell tab type, with recovery of retained Host terminals | — |
| [`ui-sidebar-right/`](ui-sidebar-right/README.md) | Holds the right Sidebar: one docking surface per session, over the docking kit and the tab-type registry | `ctx.sidebarRight` / `ctx.sidebarRightTabs` |
| [`ui-dockkit/`](ui-dockkit/README.md) | Provides the docking layout engine — a split tree of tabbed panes with invertible operations — and the components that render and drive it | — |
| [`ui-brand-official/`](ui-brand-official/README.md) | Fills the generic browser-brand slots with the official name and marks | — |
| [`ui-brand-patent/`](ui-brand-patent/README.md) | Fills the sidebar and hero brand slots with the DSH Patent name and mark | — |
| [`ui-workspace/`](ui-workspace/README.md) | Provides workspace selection and creation surfaces | — |
| [`ui-conversation/`](ui-conversation/README.md) | Presents the active conversation and its input surface | — |
| [`ui-chat/`](ui-chat/README.md) | Projects and renders the Chat conversation target | — |
| [`ui-context-menu/`](ui-context-menu/README.md) | Add actions to right-click menus without importing a React component | — |
| [`ui-file-actions/`](ui-file-actions/README.md) | Download and save original files without changing their encoding | — |
| [`ui-approval/`](ui-approval/README.md) | Presents approval requests and returns user decisions | — |
| [`ui-account-notifications/`](ui-account-notifications/README.md) | Shows server-authored account notifications beside the account menu | — |
| [`ui-tool/`](ui-tool/README.md) | Composes Tool call trees and keyed per-Tool views | — |
| [`ui-workflow-run/`](ui-workflow-run/README.md) | Replays durable workflow runs as nested chat disclosures | — |
| [`ui-goal/`](ui-goal/README.md) | Presents and manages the current goal | — |
| [`ui-trajectory/`](ui-trajectory/README.md) | Presents alternate views of agent activity | — |
| [`synapse/`](synapse/README.md) | Bridges the `/synapse/` session map into the browser: the conversation/session-map view switch and the canvas surface | — |
| [`ui-todo-board/`](ui-todo-board/README.md) | Presents the cross-session todo board as a conversation view tab, with model-authored tag filtering | — |
| [`ui-commands/`](ui-commands/README.md) | Provides session-aware command discovery and dispatch | — |
| [`ui-input-trigger/`](ui-input-trigger/README.md) | Coordinates inline command and reference suggestions | — |
| [`ui-skill/`](ui-skill/README.md) | Adds skill references to inline suggestions | — |
| [`ui-reference/`](ui-reference/README.md) | Unified Web `@file` / `@session` reference source | — |
| [`ui-secret-mask/`](ui-secret-mask/README.md) | Masks recognized credentials in sent user text | — |
| [`ui-agent-team/`](ui-agent-team/README.md) | Session Team switch and shared tasks below the Subagent tree | — |
| [`ui-subagent/`](ui-subagent/README.md) | Provides subagent navigation, child transcript states, and inline references | — |
| [`ui-jobs/`](ui-jobs/README.md) | Lists this session's background jobs with on-demand streaming record panels | — |
| [`ui-schedule/`](ui-schedule/README.md) | Provides the sidebar Automation tasks page and right Sidebar task tab, which create, edit, run, pause, resume, and delete Host scheduled tasks, plus the Session header clock and row mark | — |
| [`ui-session-panel/`](ui-session-panel/README.md) | Adds the Session header toggle and the floating Session panel whose sections plugins register, with the Environment section | — |
| [`ui-model-selection/`](ui-model-selection/README.md) | Provides model selection in conversation surfaces | — |
| [`ui-permission-presets/`](ui-permission-presets/README.md) | Configures default permissions and switches the current session's access | — |
| [`ui-plan/`](ui-plan/README.md) | Presents active plan-mode status and its exit control | — |
| [`ui-user-questions/`](ui-user-questions/README.md) | Presents interactive questions requested by the agent | — |
| [`ui-agent-preset/`](ui-agent-preset/README.md) | Selects a session's agent preset and authors preset compositions | — |
| [`ui-settings/`](ui-settings/README.md) | Hosts the settings interface and its extension areas | — |
| [`ui-settings-general/`](ui-settings-general/README.md) | Provides the general settings section | — |
| [`ui-settings-models/`](ui-settings-models/README.md) | Provides model-provider configuration and DeepSeek onboarding | — |
| [`ui-settings-shell/`](ui-settings-shell/README.md) | Provides the shell settings page on the Plugins page | — |
| [`ui-settings-agent-loop/`](ui-settings-agent-loop/README.md) | Provides the agent-loop settings page on the Plugins page | — |
| [`ui-settings-session-log/`](ui-settings-session-log/README.md) | Controls API Session-log upload in General settings | — |
| [`ui-settings-subagent/`](ui-settings-subagent/README.md) | Provides the Subagent settings page on the Plugins page | — |
| [`ui-settings-web-search/`](ui-settings-web-search/README.md) | Provides the web search and fetch settings page on the Plugins page | — |
| [`ui-settings-account/`](ui-settings-account/README.md) | Provides the Desktop Account settings page: DeepSeek login state, browser authorization, and cancellation | — |
| [`ui-plugin-manager/`](ui-plugin-manager/README.md) | Contributes the sidebar Plugins panel: install, enable, disable, retry, and compose installed packages | — |
| [`ui-connector-account/`](ui-connector-account/README.md) | Holds the accounts connector plugins register on the Host and shows each bundle's account section, tag, activation prompt, confirmations, and notices on the Plugins page | `ctx.connectorAccounts` |
| [`ui-entry-customization/`](ui-entry-customization/README.md) | Adds region-local More menus that pin or unpin plugin launchers and start a plugin draft | — |
| [`ui-plugin-market/`](ui-plugin-market/README.md) | Contributes the Discover tab to the Plugins page: browse market indexes and install their bundles | — |
| [`ui-plugin-catalog/`](ui-plugin-catalog/README.md) | Contributes the read-only Plugin catalog tab to the Plugins settings section | — |
| [`ui-deliverables/`](ui-deliverables/README.md) | Produces the changed-files card with its comparison tabs, delivery cards, and clickable final-response file references | — |
| [`ui-document-studio/`](ui-document-studio/README.md) | Contributes the document studio: a produced-files conversation view tab with host preview and open / show-in-folder / print actions | — |
| [`ui-video-studio/`](ui-video-studio/README.md) | Contributes the video production board: a conversation view tab that discovers video projects, shows shots, renders, pending tasks, and the CNY ledger, and previews media through the authenticated file route | — |
| [`ui-action-cards/`](ui-action-cards/README.md) | Shows the card frame below completed answers, kind bodies and the layer that hides card blocks | — |
| [`ui-creation-recommendations/`](ui-creation-recommendations/README.md) | Shows the personalized page card body with location selection and undo | — |
| [`ui-plugin-recommendations/`](ui-plugin-recommendations/README.md) | Shows the official plugin card body with catalog text and enabling | — |
| [`ui-message-feedback/`](ui-message-feedback/README.md) | Provides message ratings and feedback dialogs opened from ratings, `/feedback`, or the Session Header menu | `ctx.feedbackUi` |
| [`ui-directory-picker-browse/`](ui-directory-picker-browse/README.md) | In-app directory browsing surface for the workspace directory flow | — |
| [`ui-directory-picker-native/`](ui-directory-picker-native/README.md) | Native directory-picker surface driving the local Desktop or Host OS chooser | — |
| [`ui-file-drag/`](ui-file-drag/README.md) | Application-scoped file transfers and localized drag failure feedback | — |
| [`ui-open-in-app/`](ui-open-in-app/README.md) | Session-header split button opening the workspace directory in an installed application, and the document preview's default-application controls for one file | — |
| [`ui-patent-teams/`](ui-patent-teams/README.md) | Restores the PatentTeams monitor to the Web UI: one durable team card and the fixed Teams conversation view | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference and the two notes that own the cross-package composition decisions, then the host half that serves this page.

- [Client modules subsystem](../../docs/subsystems/client-modules.md) — the web plugin table: `dsh.client` declarations, the boot graph wire, and the bundle route.
- [Slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive slot model: registration, props shares, and stores.
- [Web client architecture reference](../../docs/subsystems/web-client.md) — the loading chain, object layer, and client services.
- [Host group map](../host/README.md) — the host half that serves this browser half.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
