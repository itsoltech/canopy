<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    computer,
    busy = false,
    alternative = "",
    onchange,
    class: className,
  }: {
    computer: ui.LinkedComputer;
    busy?: boolean;
    alternative?: string;
    onchange: (enabled: boolean) => Promise<void>;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let checked = $state(false);

  $effect(() => {
    if (!open) checked = computer.shareConfig && computer.peerShareConfig;
  });

  const name = $derived(computer.displayName || computer.name);
  const stopped = $derived(!computer.peerShareConfig && computer.configSyncStatus !== "needs_update");

  const description = $derived(
    stopped
      ? `${name} stopped sharing configuration. This computer keeps its copy.`
      : computer.configSyncStatus === "needs_update"
        ? "Needs an update to share configuration"
        : "Account settings follow changes on computers in the same group.",
  );

  const status = $derived(
    computer.configSyncStatus === "up_to_date"
      ? "Configuration up to date"
      : computer.configSyncStatus === "syncing"
        ? "Syncing configuration…"
        : computer.configSyncStatus === "unreachable"
          ? "Configuration sync resumes when this computer reconnects."
          : "",
  );
</script>

<div class={className}>
  <SettingsRow title="Share configuration" {description}>
    {#snippet control()}
      <Switch
        name="share-config-{computer.nodeId}"
        label="Share configuration with {name}"
        bind:checked
        disabled={busy || (stopped && computer.shareConfig) || computer.configSyncStatus === "needs_update"}
        onchange={(enabled) => {
          if (!enabled) open = true;
          else void onchange(true);
        }}
      />
    {/snippet}
    {#if status}<p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">{status}</p>{/if}
    {#if computer.configClockAheadMinutes > 5}<p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        Clock is {computer.configClockAheadMinutes} min ahead
      </p>{/if}
  </SettingsRow>
</div>
<Dialog
  bind:open
  title={`Stop sharing configuration with “${name}”?`}
  description="Both computers keep their current configuration. Later changes stay on each computer."
>
  {#if alternative}<p class="text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {name} still gets it through “{alternative}”.
    </p>{/if}
  <div class="mt-5 flex flex-wrap justify-end gap-2">
    <Button
      disabled={busy}
      onclick={() => {
        open = false;
      }}>Cancel</Button
    >
    <Button
      variant="danger"
      disabled={busy}
      onclick={async () => {
        await onchange(false);
        open = false;
      }}>Stop sharing</Button
    >
  </div>
</Dialog>
