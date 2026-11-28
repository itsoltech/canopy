<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import LinkedSkillExclusions from "./LinkedSkillExclusions.svelte";

  let {
    environment,
    skill,
    revision,
    computers,
    saving = $bindable(false),
    onback,
    ondone,
    oncomputer,
  }: {
    environment: EnvironmentState;
    skill: ui.LibrarySkill;
    revision: bigint;
    computers: ui.EnvironmentWorker[];
    saving: boolean;
    onback: () => void;
    ondone: () => void;
    oncomputer: (workerId: string) => void;
  } = $props();

  let localIds = $state<string[]>([]);
  let linkedIds = $state<string[]>([]);
  let linked: ReturnType<typeof LinkedSkillExclusions> | undefined;
  let failure = $state("");
  const busy = $derived(saving || environment.busy);
  const stale = $derived(revision !== environment.snapshot.revision);

  async function exclude() {
    if (busy || stale || (!localIds.length && !linkedIds.length)) return;
    saving = true;
    failure = "";

    try {
      const remote = linkedIds.length ? await linked?.exclude() : undefined;
      const saved = localIds.length ? await environment.excludeSkill(skill, localIds, revision) : undefined;
      const failed = [...(remote?.failed ?? [])];
      const excluded = [...(remote?.excluded ?? [])];

      for (const worker of computers.filter(({ workerId }) => localIds.includes(workerId))) {
        (saved ? excluded : failed).push(worker.name);
      }

      if (excluded.length) {
        environment.notice = `Excluded ${excluded.join(", ")} from sync for “${skill.name}”.`;
      }

      if (failed.length) {
        failure = [
          excluded.length && environment.notice,
          `Couldn’t exclude ${failed.join(", ")}. Go back and review the computers before trying again.`,
        ]
          .filter(Boolean)
          .join(" ");
      } else if (excluded.length) ondone();
    } finally {
      saving = false;
    }
  }
</script>

<p>Choose which computers should stop syncing “{skill.name}”.</p>
<fieldset class="grid min-w-0 gap-2" disabled={busy}>
  <legend class="sr-only">Computers to exclude</legend>
  {#each computers as worker (worker.workerId)}
    <Checkbox
      name={worker.workerId}
      label={worker.name}
      bind:checked={
        () => localIds.includes(worker.workerId),
        (checked) =>
          (localIds = checked ? [...localIds, worker.workerId] : localIds.filter((id) => id !== worker.workerId))
      }
    />
  {/each}
  <LinkedSkillExclusions bind:this={linked} {environment} {skill} {busy} {oncomputer} bind:selected={linkedIds} />
</fieldset>
<p class="text-muted">
  On these computers, Canopy uninstalls its unedited copies. Folders and links you installed yourself stay in place.
</p>
{#if failure}<Alert tone="error">{failure}</Alert>
{:else if stale && !saving}<Alert>The skill changed. Go back to review its current assignment.</Alert>{/if}
<div class="flex flex-wrap justify-end gap-2">
  <Button disabled={busy} onclick={onback}>Back</Button>
  <Button
    variant="primary"
    loading={saving}
    disabled={busy || stale || (!localIds.length && !linkedIds.length)}
    onclick={exclude}>Exclude from sync</Button
  >
</div>
