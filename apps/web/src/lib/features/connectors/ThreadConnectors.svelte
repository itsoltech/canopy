<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { accountStatus } from "./api.ts";
  import ThreadConnectorDialog from "./ThreadConnectorDialog.svelte";
  import type { useThreadPanel } from "#lib/features/threads/thread-panel.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import type { Tone } from "#lib/shared/ui/tone.ts";

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

  /** A badge only for a known state; an account nobody has used in this thread yet shows just its name. */
  function sessionLook(account: (typeof accounts)[number]): { label: string; tone: Tone; hint?: string } | undefined {
    if (account.status !== "connected") return { label: accountStatus(account.status), tone: "amber" };

    switch (account.sessionState) {
      case "available":
        return { label: "Available", tone: "emerald" };
      case "pending":
        return { label: "Available next turn", tone: "sky" };
      case "pending_removal":
        return { label: "Access removed", tone: "amber", hint: "Tools update next turn" };
      case "unavailable":
        return { label: "Unavailable", tone: "neutral", hint: "No tools available" };
      case "failed":
        return { label: "Error", tone: "rose" };
      default:
        return undefined;
    }
  }
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
  {#if accounts.length > 0}<ul role="list" class="grid">
      {#each accounts as account (account.accountId)}
        {@const state = sessionLook(account)}
        <li class="grid min-w-0">
          <div class="flex min-h-7 min-w-0 items-center gap-2">
            <Icon name="link" /><span class="min-w-0 flex-1 truncate"
              >{account.connectorName} · {account.accountLabel}</span
            >{#if state}<span role="status" class="contents" {@attach tooltip(state.hint)}
                ><Badge compact tone={state.tone}>{state.label}</Badge></span
              >{/if}
          </div>
          {#if account.status === "connected" && account.sessionState === "failed" && account.sessionDetail}<p
              class="pb-1 pl-6 text-pretty text-zinc-500 dark:text-zinc-400"
            >
              {account.sessionDetail}
            </p>{/if}
        </li>
      {/each}
    </ul>{/if}
</section>

<ThreadConnectorDialog bind:open={managing} {thread} {panel} {disabled} {homeName} />
