<script lang="ts">
  import { untrack } from "svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import DocumentEditor from "#lib/features/agent-environment/DocumentEditor.svelte";
  import SkillsLibrary from "#lib/features/agent-environment/SkillsLibrary.svelte";
  import MarketplaceLibrary from "#lib/features/agent-environment/MarketplaceLibrary.svelte";
  import ComputerPlugins from "#lib/features/agent-environment/ComputerPlugins.svelte";
  import AssignmentSummary from "#lib/features/agent-environment/AssignmentSummary.svelte";
  import EnvironmentComputer from "#lib/features/agent-environment/EnvironmentComputer.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const state = new EnvironmentState(untrack(() => data.environment));
  const overview = useOverview();

  const worker = $derived(
    state.snapshot.workers.find((w) => w.workerId === state.workerId) ?? state.snapshot.workers[0],
  );

  $effect(() =>
    overview.subscribe((update) => {
      if (
        update.change.case === "agentEnvironmentChanged" ||
        update.change.case === "worker" ||
        update.change.case === "workerRemoved"
      )
        void state.refresh();
    }),
  );

  $effect(() => {
    if (overview.resyncs > 0) void state.refresh();
  });
</script>

<div class="grid min-w-0 gap-7">
  <SettingsHeading
    title="Agent environment"
    description="Instructions, skills and plugins that follow your computers. Assign by tag and see exactly what each agent receives."
  />
  {#if state.error}<Alert tone="error">{state.error}</Alert>{/if}
  {#if state.notice}<Alert>{state.notice}</Alert>{/if}
  <section class="grid min-w-0 gap-4" aria-label="Instruction library">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-balance">Instruction library</h2>
      {#if !state.draft}<Button size="sm" onclick={() => state.edit()}>Add document</Button>{/if}
    </div>
    {#if state.draft}
      {#if state.editConflict}
        <Alert tone="warning"
          >The environment changed while you were editing. Copy any unsaved text you want to keep, then reload the saved
          document.</Alert
        >
        <div><Button onclick={() => state.reloadDraft()}>Discard draft and reload</Button></div>
      {/if}
      <DocumentEditor
        bind:document={state.draft}
        workers={state.snapshot.workers}
        busy={state.busy}
        conflict={state.editConflict}
        onsave={() => state.save()}
        oncancel={() => (state.draft = undefined)}
      />
    {:else}
      <div class="grid divide-y divide-zinc-950/10 dark:divide-white/10">
        {#each state.snapshot.documents as document (document.id)}
          <div class="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0">
            <button
              type="button"
              class="relative grid min-w-0 flex-1 gap-1 rounded-md py-1 text-left focus-ring hover:text-brand-600 dark:hover:text-brand-400"
              onclick={() => state.edit(document)}
            >
              <TouchTarget />
              <p class="truncate text-base font-medium sm:text-sm">{document.name}</p>
              <p class="text-base text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400">
                {document.harness === "claude" ? "CLAUDE.md" : "AGENTS.md"} · {document.fragments.length} fragments · v{document.revision.toString()}
              </p>
              <AssignmentSummary
                selector={document.selector}
                workers={state.snapshot.workers}
                disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
              />
            </button>
            <Button size="sm" variant="ghost" disabled={state.busy} onclick={() => state.remove(document)}
              >Delete</Button
            >
          </div>
        {:else}
          <div class="grid gap-2 rounded-xl bg-zinc-950/3 p-5 dark:bg-white/4">
            <h3 class="text-base font-medium text-balance">Make every agent feel at home</h3>
            <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
              Start with your working style. Add a Windows fragment, a work tag, or an extra note for one machine.
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>
  <SkillsLibrary environment={state} />
  <MarketplaceLibrary environment={state} />
  <section
    class="grid min-w-0 gap-5 border-t border-zinc-950/10 pt-6 dark:border-white/10"
    aria-label="Environment computers"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-balance">Computers & preview</h2>
      <Button size="sm" variant="ghost" disabled={state.busy} onclick={() => state.refresh()}>Refresh status</Button>
    </div>
    {#if worker}
      <Field label="Computer"
        ><Select
          name="environment-computer"
          bind:value={state.workerId}
          options={state.snapshot.workers.map((w) => ({
            value: w.workerId,
            label: `${w.name}${w.online ? "" : " · Offline"}`,
          }))}
        /></Field
      >
      <div class="flex flex-wrap gap-2">
        <Badge>{worker.online ? "Online" : "Offline"}</Badge><Badge>This computer's workers</Badge>
      </div>
      {#key worker.workerId}<EnvironmentComputer {worker} {state} />{/key}
      {#key worker.workerId}<ComputerPlugins {worker} environment={state} />{/key}
    {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        Add a worker in Settings → Workers to preview and sync instructions.
      </p>{/if}
  </section>
</div>
