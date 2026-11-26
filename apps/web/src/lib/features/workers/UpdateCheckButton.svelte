<script lang="ts">
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { type UpdatesState, updateBusy } from "./updates.svelte.ts";

  let {
    updates,
    app,
    compact = false,
  }: { updates: UpdatesState; app: DesktopUpdatesState; compact?: boolean } = $props();

  const snapshot = $derived(updates.snapshot);

  const canCheckGateway = $derived(
    updates.readable &&
      !updates.gatewayTransition &&
      !updates.pending &&
      !snapshot?.checking &&
      !updateBusy(snapshot?.gatewayState ?? ""),
  );

  const canCheckApp = $derived(
    (!!app.status || !!window.canopyDesktop?.checkForUpdates) &&
      !app.pending &&
      !app.restarting &&
      !app.status?.changingChannel &&
      !["disabled", "downloading", "checking"].includes(app.status?.phase ?? ""),
  );

  let checking = $state(false);
  const disabled = $derived(!canCheckGateway && !canCheckApp);

  const loading = $derived(
    checking ||
      (disabled &&
        !!(snapshot?.checking || updates.pending === "check" || app.pending || app.status?.phase === "checking")),
  );

  async function check() {
    if (checking || disabled) return;
    checking = true;

    try {
      await Promise.all([
        canCheckGateway
          ? updates.writable && (snapshot?.admin || snapshot?.gatewayBundled)
            ? updates.manage({ action: "check" })
            : updates.reload()
          : undefined,
        canCheckApp ? app.check() : undefined,
      ]);
    } finally {
      checking = false;
    }
  }
</script>

{#if compact}
  <IconButton size="sm" icon="arrow-path" label="Check now" {disabled} {loading} onclick={() => void check()} />
{:else}
  <Button size="sm" {disabled} {loading} onclick={() => void check()}>Check for updates</Button>
{/if}
