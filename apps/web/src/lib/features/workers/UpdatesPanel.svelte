<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { isRateLimitMessage } from "@canopy/domain/release/http";
  import UpdateActionButton from "./UpdateActionButton.svelte";
  import UpdateCheckButton from "./UpdateCheckButton.svelte";
  import UpdateRows from "./UpdateRows.svelte";
  import UpdateRun from "./UpdateRun.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updatesHeadline } from "./updates-headline.ts";

  let {
    updates,
    app,
    class: className,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue } = $props();

  const snapshot = $derived(updates.snapshot);

  const checking = $derived(
    !!(snapshot?.checking || updates.pending === "check" || app.pending || app.status?.phase === "checking"),
  );

  const headline = $derived(updatesHeadline(updates, app, checking));

  const error = $derived(
    (updates.readable && (updates.error || (!updates.gatewayTransition && snapshot?.checkError))) || "",
  );
</script>

{#if updates.readable || app.status || app.error}
  <SettingsGroup title="Update status" class={className}>
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
      <p class="min-w-0 text-sm/5 font-medium tabular-nums" role="status">{headline.text}</p>
      <div class="flex flex-wrap items-center gap-2">
        <UpdateCheckButton {updates} {app} />
        <UpdateActionButton {updates} variant="primary" />
      </div>
    </div>
    {#if error}<div class="p-3"><Alert tone={isRateLimitMessage(error) ? "info" : "error"}>{error}</Alert></div>{/if}
    {#if updates.run && updates.run.state !== "dismissed"}
      <UpdateRun run={updates.run} {updates} class="px-3 py-2" />
    {/if}
    <div class="min-w-0 px-3">
      <UpdateRows {updates} {app} />
      {#if updates.readable && !snapshot && !error}<p class="py-2 text-sm/5 text-muted" role="status">
          Loading gateway updates…
        </p>{/if}
    </div>
    {#if snapshot}
      <Disclosure class="px-3 py-2 text-sm/5 text-muted">
        {#snippet summary()}Update order{/snippet}
        <p class="pt-2 text-pretty">
          Workers wait for their gateway. Offline computers and workers are skipped. Independent updates continue after
          a failure. The results list the installer for items that need a manual update.
        </p>
      </Disclosure>
    {/if}
  </SettingsGroup>
{/if}
