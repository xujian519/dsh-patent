# Agent Note: Starting the browser application when a profile-installed client plugin fails

Status: implemented
Archived: 2026-11-12

English | [中文](2026-09-27-profile-installed-client-entry-tolerance.zh.md)

## Problem

The client boot audit ([`packages/client/web/src/boot-client.ts`](../../../../packages/client/web/README.md)) treated every inactive Loader entry as fatal: `loader.await()`, then one aggregated throw. A row whose package the active profile installed is the browser half of a plugin the deployment does not own, and the graph-sync reconciliation retries failed entries (`ClientEntries.reconcile` calls `fiber.update`), so an entry can throw on its first activation attempt and activate moments later.

`@niyongsheng/free-vision-skill` is that case. Its client `apply` calls `ctx.slots.register('conversation.input.right', …)` while its fiber waits only on the `slots` service, and `ui-conversation` declares that key later, inside its own `slots.inject('main', …)` chain. Measured in the Web composition: the first `apply` threw `slot "conversation.input.right" is not declared` at 144 ms, the audit judged at 199 ms, and the retry succeeded at 621 ms. The audit's verdict is final and the page never re-audits, so the Desktop reported a fatal startup failure, kept its boot page, and offered only recovery that disables every third-party plugin. The report named the entry as `failed` and dropped the activation error behind it, so the crash report and the dialog could not explain it.

The Host half already made this distinction: [the startup audit](../../../../packages/boot/app-boot/README.md) rejects startup only for required entry ids and warns for the rest. The client half had no such notion, so a plugin's browser half could brick the application while its Host half was a warning.

## Decision

A boot row is required unless the active profile installed its package, and `auditClientActivation` applies one policy to both classes:

- **The profile's own manifest decides the class.** [`PluginPackages.installedByProfile`](../../../../packages/boot/app-boot/README.md) reports the runtime resolution's `localPackageNames` — the dependencies the active profile declares and has installed in its own `node_modules`. The [`clientModules` Host half](../../../../packages/client/modules/README.md) marks such rows `required: false` on the boot graph; every other row, and any entry outside the graph, stays required.
- **Inactive required entries reject startup**, with the whole inactive set named; **inactive profile-installed entries warn**, and the running application carries them: Settings → Plugins → Plugin list reports a failed client entry with its message and retries it ([`ui-settings-plugin-inventory`](../../../../packages/client/ui-settings-plugin-inventory/README.md)).
- **Every line names its reason**: `import failed: <recorded import error>`, `pending (waiting for services: …)`, or `failed: <message of the fiber's settled activation error>`, which the audit reads through `fiber.await()`. Required entries are marked `(required)` in the blocking report.
- `SlotCore.register` still throws for an undeclared slot key, and [the client authoring rule](../../../../packages/client/AGENTS.md) still requires `ctx.slots.inject(name, () => ctx.slots.register(…))` for a cross-package registration. Only the startup consequence of violating it changed, and only for rows the profile owns.

## Alternatives considered

**Fix the plugin's registration and leave the audit strict.** The plugin does violate the authoring rule, and its `slots.inject` form works. But the audit judged a condition that resolved 400 ms later, and the same defect in the next user-installed plugin would brick the application again. Reporting the plugin upstream does not replace the policy.

**Make `SlotCore.register` wait for a late declaration.** The registration would land on its own, and the entry would never fail. It also removes the failure that catches a mistyped or mis-scoped key, which `slots.inject` exists to express deliberately; the declaration contract ("declaring is claiming") stays as it is.

**Retry the inactive entries inside the audit, then judge.** At the audit instant the key is still undeclared — the declaration arrives later inside `ui-conversation`'s activation chain — so an immediate retry fails again, and a wait would need an arbitrary deadline in the boot path. The retry that succeeds rides the Host graph sync, whose arrival the boot kernel cannot bound.

**Keep the strict audit and rely on the Desktop recovery button.** It disables every third-party plugin rather than the failing one, so working plugins are lost, and it leaves the crash report without the activation error it exists to carry.

**Treat the audit's result as a warning for every row.** A shipped row that fails to activate would then leave the shell mounting against an incomplete roster, which the boot page and the mount handoff cannot report as such; the required class keeps that failure loud.

## Testing

| Evidence | Behaviour |
|---|---|
| [boot-client.client.spec.ts](../../../../packages/client/web/tests/boot-client.client.spec.ts) | A profile-installed row that throws during `apply` resolves boot and warns with the activation message; a required row still rejects with every inactive entry, its reason, and its `(required)` mark; an entry outside the boot graph is required; a failed fiber that rethrows no reason and one that rethrows a non-Error are both reported. |
| [loader.client.spec.ts](../../../../packages/client/modules/tests/loader.client.spec.ts) | The wire carries `required: false`, an unmarked row normalizes to required, and a non-boolean mark is rejected. |
| [node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) | The Host marks only the rows the profile installed; without the package-lookup service every row stays required. |
| [profile-resolution-service.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution-service.spec.ts) | `installedByProfile` follows the resolution and a replaced generation; a service without a resolution reports none. |

Verified live in the Web composition with `@niyongsheng/free-vision-skill@0.3.1` installed in a profile: the boot page is replaced by the application, the console carries `web boot: warning: 1 entry did not activate / @niyongsheng/free-vision-skill: failed: slot "conversation.input.right" is not declared (a parent entry's children table must declare it)`, and the plugin's entry activates on the graph sync. The same package resolved outside the profile (required) still stops at the boot page with `web boot: 1 required entry did not activate / … (required): failed: slot …`.

## Consequences

- A user-installed plugin's browser half can no longer keep the application from starting; its failure is a console warning at boot and a retried, visible entry in Settings → Plugins afterwards.
- A shipped row's failure, and a pending row that a shipped row depends on, still blocks startup, so the roster the shell mounts against stays complete in the surfaces the deployment owns.
- The boot page and the Desktop crash dialog now name the activation error of a failed entry instead of the bare state.
- The boot graph gained `required` (omitted when true). A Host that does not send it produces required rows, which is the earlier behaviour.
- The client boot kernel reads one Host service for which packages the profile installed. Without it (a profile launched without the package-lookup service, and the unit fixtures), every row is required.
- A profile-installed entry that fails permanently stays inactive for the page's lifetime until Settings → Plugins retries it; the plugin contributes nothing to the UI until then.
