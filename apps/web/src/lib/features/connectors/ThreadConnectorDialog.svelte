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
    project,
    panel,
    disabled,
    homeName,
    class: className,
  }: {
    open?: boolean;
    thread: ui.Thread;
    project: ui.Project | undefined;
    panel: ReturnType<typeof useThreadPanel>;
    disabled: boolean;
    homeName: string;
    class?: ClassValue;
  } = $props();

  const noProject = $derived(project?.kind === "scratch");
  const hasProject = $derived(project?.kind === "project" && !project.archivedAt);
  const accounts = $derived(panel.data?.connectors.filter((account) => account.revision > 0n) ?? []);
  const hasLegacyGrants = $derived(accounts.some((account) => account.allProjects === undefined));

  const description = $derived(
    noProject
      ? "Access applies to every thread in No project."
      : hasProject
        ? "Changes apply to every thread in this project."
        : "This thread has no active project.",
  );

  let pending = $state<{ accountId: string; granted: boolean }>();
  let error = $state("");

  async function change(account: ui.ThreadConnector, granted: boolean) {
    if (disabled || !hasProject || pending || account.allProjects !== false || thread.status === "archived") return;
    pending = { accountId: account.accountId, granted };
    error = "";

    try {
      await panel.grant(account, granted);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not change access. Reload and try again.";
    } finally {
      pending = undefined;
    }
  }
</script>

<Dialog bind:open title={noProject ? "Connector access" : "Manage connector access"} {description}>
  <div class={["grid min-w-0 gap-3", className]}>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if hasProject && hasLegacyGrants}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Update the gateway to manage project access.</p>
    {/if}
    {#each accounts as account (account.accountId)}
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="min-w-0">
          <p
            class="text-base/6 wrap-anywhere text-zinc-800 sm:text-sm/6 dark:text-zinc-200"
            title={account.accountLabel}
          >
            {account.connectorName} · {account.accountLabel}
          </p>
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{accountStatus(account.status)}</p>
          {#if noProject}
            <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
              {account.granted ? "Access granted" : "No access"}
            </p>
          {:else if account.allProjects}
            <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">All projects</p>
          {/if}
        </div>
        {#if !noProject}
          <Switch
            checked={pending?.accountId === account.accountId ? pending.granted : account.granted}
            name={account.accountId}
            label={`Allow ${account.connectorName} · ${account.accountLabel}`}
            disabled={disabled ||
              !hasProject ||
              account.allProjects !== false ||
              !!pending ||
              thread.status === "archived"}
            onchange={(granted) => change(account, granted)}
          />
        {/if}
      </div>
    {:else}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">No connector accounts</p>{/each}
    {#if !thread.nodeId}
      <a class="text-sm/5 text-zinc-500 underline dark:text-zinc-400" href="/settings/connectors">
        {noProject ? "Open connector settings" : "Manage accounts"}
      </a>
    {:else if noProject}
      <p class="text-sm/5 wrap-anywhere text-zinc-500 dark:text-zinc-400">
        Open Settings → Connectors on “{homeName}”.
      </p>
    {:else}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Manage accounts on {homeName}</p>
    {/if}
  </div>
</Dialog>
