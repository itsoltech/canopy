<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { computerUpdate } from "#lib/features/workers/computer-updates.ts";
  import { UpdatesState, updateTone } from "#lib/features/workers/updates.svelte.ts";

  /**
   * Linked computers' Canopy apps (docs/updates.md, "Połączone komputery"). Each computer owns its channel and check
   * frequency, so they are read-only here; Update and Check now ask that computer, which uses its own settings.
   */
  let {
    class: className,
    fixture,
  }: {
    class?: ClassValue;
    /** Development fixtures (/dev/updates): fixed state, no polling. */
    fixture?: UpdatesState;
  } = $props();

  const given = untrack(() => fixture);
  const updates = given ?? new UpdatesState();
  const computers = $derived(updates.snapshot?.computers ?? []);
  let action = $state("");

  const CHANNELS = new Map([
    ["stable", "Stable"],
    ["beta", "Beta"],
    ["nightly", "Nightly"],
  ]);

  onMount(() => {
    if (given) return;
    void updates.reload();
    const timer = setInterval(() => void updates.reload(), 5000);

    return () => clearInterval(timer);
  });

  function run(kind: "computer" | "computer_check", computer: ui.ComputerUpdate) {
    action = kind;
    void updates.manage({ action: kind, nodeId: computer.nodeId });
  }
</script>

{#if computers.length}
  <SettingsGroup
    title="Linked computers"
    description="Each computer keeps its own channel and check frequency. Change them on that computer."
    class={className}
  >
    {#each computers as computer (computer.nodeId)}
      {@const view = computerUpdate(computer)}
      {@const app = computer.updates?.app}
      {@const version = app?.version || computer.version}
      {@const channel = CHANNELS.get(app?.channel ?? "")}
      {@const pending = updates.pending === computer.nodeId}
      <!-- A computer too old for remote updates says so once, in the control. -->
      {@const detail = computer.remoteUpdate || computer.presence !== "connected" ? view.detail : ""}
      <SettingsRow title={computer.name}>
        <!-- The status follows the versions, so its changing width moves nothing after it. -->
        <p class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
          <span class="min-w-0 truncate tabular-nums" title={version}
            >{version || "Version unknown"}{view.target && view.target !== version ? ` → ${view.target}` : ""}{channel
              ? ` · ${channel}`
              : ""}</span
          ><Badge compact tone={updateTone(view)}>{view.status}</Badge>
        </p>
        {#if detail}<p
            class={[
              "mt-1 text-sm/5 text-pretty",
              view.failed ? "text-rose-600 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400",
            ]}
          >
            {detail}
          </p>{/if}
        {#snippet control()}
          {#if computer.remoteUpdate}
            <!-- Both buttons always render; state only disables them, so nothing shifts. -->
            <Button
              size="sm"
              disabled={!!updates.pending || computer.presence !== "connected" || !app?.connected}
              loading={pending && action === "computer_check"}
              onclick={() => run("computer_check", computer)}>Check now</Button
            >
            <Button
              size="sm"
              variant={view.actionable ? "primary" : "secondary"}
              disabled={!!updates.pending || !view.actionable || updates.snapshot?.run?.state === "running"}
              loading={pending && action === "computer"}
              onclick={() => run("computer", computer)}>Update</Button
            >
          {:else}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400">Update on that computer</span>{/if}
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
{#if updates.error && computers.length}<Alert tone="error" class="mt-4">{updates.error}</Alert>{/if}
