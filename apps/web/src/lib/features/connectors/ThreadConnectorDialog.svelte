<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { useThreadPanel } from "#lib/features/threads/thread-panel.svelte.ts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { accountStatus } from "./api.ts";

  let {
    open = $bindable(false),
    thread,
    panel,
    disabled,
    homeName,
    class: className,
  }: {
    open?: boolean;
    thread: ui.Thread;
    panel: ReturnType<typeof useThreadPanel>;
    disabled: boolean;
    homeName: string;
    class?: ClassValue;
  } = $props();

  let busy = $state("");
  let error = $state("");

  async function change(account: ui.ThreadConnector, granted: boolean) {
    busy = account.accountId;
    error = "";

    try {
      await panel.grant(account, granted);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not change access. Reload and try again.";
    } finally {
      busy = "";
    }
  }
</script>

<Dialog bind:open title="Manage connector access" description="Changes apply to every thread on this worker.">
  <div class={["grid min-w-0 gap-3", className]}>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#each panel.data?.connectors ?? [] as account (account.accountId)}
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="truncate text-base/6 text-zinc-800 sm:text-sm/6 dark:text-zinc-200" title={account.accountLabel}>
            {account.connectorName} · {account.accountLabel}
          </p>
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{accountStatus(account.status)}</p>
          {#if account.allWorkers}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
              All workers · Manage on {homeName}
            </p>{/if}
        </div>
        <Switch
          checked={account.granted}
          name={account.accountId}
          label={`Allow ${account.connectorName} · ${account.accountLabel}`}
          disabled={disabled || account.allWorkers || !!busy || thread.status === "archived"}
          onchange={(granted) => change(account, granted)}
        />
      </div>
    {:else}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">No connector accounts</p>{/each}
    {#if !thread.nodeId}<a class="text-sm/5 text-zinc-500 underline dark:text-zinc-400" href="/settings/connectors"
        >Manage accounts</a
      >
    {:else}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Manage accounts on {homeName}</p>{/if}
  </div>
</Dialog>
