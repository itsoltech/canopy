<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { accountStatus } from "./api.ts";
  import ThreadConnectorDialog from "./ThreadConnectorDialog.svelte";
  import type { useThreadPanel } from "#lib/features/threads/thread-panel.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let {
    thread,
    panel,
    disabled,
    homeName,
    class: className,
  }: {
    thread: ui.Thread;
    panel: ReturnType<typeof useThreadPanel>;
    disabled: boolean;
    homeName: string;
    class?: ClassValue;
  } = $props();

  let managing = $state(false);

  const accounts = $derived(
    panel.data?.connectors.filter((account) => account.granted || account.sessionAttached) ?? [],
  );

  const status = $derived(
    panel.error ||
      (!panel.data ? "Loading connections…" : panel.data.unavailable ? "Connect to load connector access." : ""),
  );
</script>

<section aria-label="Connectors" class={["grid min-w-0 gap-1 px-3.5 py-1.5 text-base/6 sm:text-xs/5", className]}>
  <div class="flex items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-2">
      <h2 class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Connectors</h2>
      {#if !status && !accounts.length}<span
          class="text-zinc-500 dark:text-zinc-400"
          role="status"
          aria-label="No accounts granted to this worker">None</span
        >{/if}
    </div>
    <button
      type="button"
      disabled={disabled || !panel.data}
      onclick={() => (managing = true)}
      class="shrink-0 text-zinc-500 underline decoration-zinc-400/50 underline-offset-2 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
      >Manage</button
    >
  </div>
  {#if status}<p role="status" class="text-zinc-500 dark:text-zinc-400">{status}</p>{/if}
  {#if accounts.length > 0}<ul role="list" class="grid gap-2">
      {#each accounts as account (account.accountId)}<li
          class="grid min-w-0 gap-1"
          title={accountStatus(account.status)}
        >
          <div class="flex min-w-0 items-center gap-2">
            <Icon name="link" /><span class="min-w-0 flex-1 truncate"
              >{account.connectorName} · {account.accountLabel}</span
            >{#if account.status !== "connected"}<span class="shrink-0 text-amber-700 dark:text-amber-400"
                >{accountStatus(account.status)}</span
              >{/if}
          </div>
          <p class="min-h-5 pl-6 text-zinc-500 dark:text-zinc-400" role="status">
            {#if account.sessionState === "available"}Available
            {:else if account.sessionState === "pending"}Available next turn
            {:else if account.sessionState === "pending_removal"}Access removed · Tools update next turn
            {:else if account.sessionState === "failed"}{account.sessionDetail}
            {:else if account.sessionState === "unavailable" && account.status === "connected"}No tools available
            {:else if !account.sessionState}Send a message to check tool availability{/if}
          </p>
        </li>{/each}
    </ul>{/if}
</section>

<ThreadConnectorDialog bind:open={managing} {thread} {panel} {disabled} {homeName} />
