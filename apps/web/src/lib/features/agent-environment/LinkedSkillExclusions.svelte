<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import {
    excludeLinkedWorker,
    linkedEligibility,
    linkedSkillCandidates,
    sharedSkillItem,
    type Eligibility,
  } from "./linked-skill-exclusions.ts";

  let {
    environment,
    skill,
    selected = $bindable([]),
    busy,
    oncomputer,
  }: {
    environment: EnvironmentState;
    skill: ui.LibrarySkill;
    selected: string[];
    busy: boolean;
    oncomputer: (workerId: string) => void;
  } = $props();

  const candidates = $derived(linkedSkillCandidates(environment.linkedWorkers, skill));

  const readableIds = $derived(
    candidates
      .filter((r) => !r.readOnlyReason)
      .map((r) => r.workerId)
      .join(","),
  );

  const localWorker = $derived(environment.snapshot.workers[0]?.workerId ?? "");
  const skillId = $derived(skill.id);
  let checks = $state.raw<Record<string, Eligibility>>({});
  const label = (r: ui.WorkerRecord) => (r.name === r.computerName ? r.name : `${r.name} · ${r.computerName}`);

  $effect(() => {
    const controller = new AbortController();
    selected = [];
    checks = {};

    if (readableIds) void load(readableIds.split(","), localWorker, skillId, controller.signal);

    return () => controller.abort();
  });

  async function load(ids: string[], worker: string, id: string, signal: AbortSignal) {
    const item = await sharedSkillItem(worker, id, signal).catch(() => undefined);

    // Each response includes the worker's full environment report. Limit simultaneous reads.
    for (let offset = 0; offset < ids.length && !signal.aborted; offset += 3) {
      await Promise.all(
        ids.slice(offset, offset + 3).map(async (workerId) => {
          const check = item
            ? await linkedEligibility(workerId, item, signal).catch(() => ({
                reason: "Couldn’t check this computer’s assignment.",
              }))
            : { reason: "Check this skill in the computer’s library." };

          if (!signal.aborted) checks = { ...checks, [workerId]: check };
        }),
      );
    }
  }

  export async function exclude() {
    const excluded: string[] = [];
    const failed: string[] = [];
    // Workers at one home share a revision. Only advance it across our own consecutive confirmed writes.
    const revisions = new Map<string, { reviewed: bigint; next: bigint }>();

    const reviewed = selected.map((workerId) => ({
      workerId,
      record: candidates.find((r) => r.workerId === workerId),
      check: checks[workerId],
    }));

    for (const { record, workerId, check } of reviewed) {
      const name = record ? label(record) : workerId;

      if (!record || record.readOnlyReason || !check || !("assignment" in check)) {
        failed.push(name);
        continue;
      }

      const assignment = check.assignment;
      const previous = revisions.get(record.nodeId);
      const revision = previous?.reviewed === assignment.revision ? previous.next : assignment.revision;

      try {
        const next = await excludeLinkedWorker(workerId, assignment, revision);

        if (next === revision + 1n) revisions.set(record.nodeId, { reviewed: assignment.revision, next });
        checks = { ...checks, [workerId]: { reason: "Already excluded from sync." } };
        excluded.push(name);
      } catch {
        checks = { ...checks, [workerId]: { reason: "Couldn’t confirm the change. Check this computer." } };
        failed.push(name);
      }
    }

    selected = [];

    return { excluded, failed };
  }

  function toggle(id: string, checked: boolean) {
    selected = checked ? [...selected, id] : selected.filter((value) => value !== id);
  }
</script>

{#if candidates.length}
  <fieldset class="grid min-w-0 gap-2" disabled={busy}>
    <legend class="mb-2 font-medium">Linked computers</legend>
    {#each candidates as record (record.workerId)}
      {@const id = record.workerId}
      {@const check = checks[id]}
      {@const reason = record.readOnlyReason || (check && "reason" in check ? check.reason : "")}
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 wrap-anywhere">
        <Checkbox
          class="min-w-0 flex-1"
          name={id}
          label={label(record)}
          description={reason || (check ? undefined : "Checking assignment…")}
          disabled={busy || !!reason || !check}
          bind:checked={() => selected.includes(id), (checked) => toggle(id, checked)}
        />
        {#if reason}<Button
            size="sm"
            variant="text"
            aria-label={`Open computer ${label(record)}`}
            onclick={() => oncomputer(id)}>Open computer</Button
          >{/if}
      </div>
    {/each}
  </fieldset>
{/if}
