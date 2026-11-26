<script lang="ts">
  import { tick } from "svelte";
  import type { EnvironmentSkillStatus, ui } from "@canopy/contracts";
  import {
    assignedWorkers,
    canKeepBlockedSkill,
    isLocalSkillConflict,
    skillSyncReports,
  } from "@canopy/domain/environment-library";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import ComputerSkillLocation from "./ComputerSkillLocation.svelte";
  import { archiveLocation, awaitingArchive, canArchive, needsAttention, skillLocation } from "./computer-skills.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let { environment, oncomputer }: { environment: EnvironmentState; oncomputer: (id: string) => void } = $props();

  type Location = { workerId: string; file: EnvironmentSkillStatus };

  type Archive = Location & { revision: bigint; computer: string };

  let open = $state(false);
  let skillId = $state("");
  let skillName = $state("");
  let decision = $state.raw<Archive>();
  let lastArchive = $state.raw<Archive>();
  let saving = $state(false);
  let error = $state("");
  let confirmActions = $state<HTMLDivElement>();
  let details = $state<HTMLDivElement>();

  const skill = $derived(environment.snapshot.skills.find((s) => s.id === skillId));

  const workers = $derived(
    skill
      ? assignedWorkers(environment.workers, skill.selector, skill.overrides)
          .map((worker) => ({
            worker,
            files: skillSyncReports(worker, skillId).filter((f) => needsAttention(f) || f.status === "kept"),
          }))
          .filter(({ files }) => files.length)
      : [],
  );

  const busy = $derived(saving || environment.busy);
  const stale = $derived(decision && !canConfirm(decision));
  const outcome = $derived(lastArchive && archiveOutcome(lastArchive));

  function restoreFocus() {
    // The review button goes away once the last issue is resolved.
    requestAnimationFrame(() => {
      if (open || document.activeElement !== document.body) return;
      document.getElementById(`environment-item-${skillId}`)?.querySelector<HTMLElement>("[data-item-focus]")?.focus();
    });
  }

  export function show(id: string) {
    const item = environment.snapshot.skills.find((entry) => entry.id === id);

    if (!item) return;

    if (skillId !== id) lastArchive = undefined;
    skillId = id;
    skillName = item.name;
    decision = undefined;
    error = "";
    open = true;
  }

  function current(worker: ui.EnvironmentWorker | undefined) {
    return (
      worker?.online &&
      worker.supported &&
      worker.skillsSupported &&
      !worker.compositionError &&
      worker.report?.revision === worker.desiredRevision
    );
  }

  function canConfirm(archive: Archive) {
    if (archive.revision !== environment.snapshot.revision) return false;
    const item = workers.find(({ worker }) => worker.workerId === archive.workerId);
    const file = item?.files.find((entry) => entry.targetId === archive.file.targetId);

    return (
      current(item?.worker) &&
      file &&
      canArchive(file) &&
      file.archiveToken === archive.file.archiveToken &&
      file.desiredChecksum === archive.file.desiredChecksum &&
      file.path === archive.file.path
    );
  }

  function archiveOutcome(archive: Archive) {
    const worker = environment.snapshot.workers.find((w) => w.workerId === archive.workerId);
    const file = worker?.report?.skills.find((f) => f.targetId === archive.file.targetId);

    if (!current(worker) || (file && awaitingArchive(file, archive.file))) return "pending";

    if (file?.status === "applied" && file.owned) return "installed";

    if (file?.status === "removed" || (!file && worker?.report?.skillInventoryScanned)) return "archived";

    return "unconfirmed";
  }

  function waitingForArchive(workerId: string, file: EnvironmentSkillStatus) {
    return lastArchive?.workerId === workerId && awaitingArchive(file, lastArchive.file);
  }

  async function reviewArchive(worker: ui.EnvironmentWorker, file: EnvironmentSkillStatus) {
    decision = { workerId: worker.workerId, computer: worker.name, file, revision: environment.snapshot.revision };
    error = "";
    await tick();
    confirmActions?.querySelector("button")?.focus();
  }

  async function back() {
    decision = undefined;
    error = "";
    await tick();
    details?.focus();
  }

  function localCopyIssue(file: EnvironmentSkillStatus) {
    return isLocalSkillConflict(file) || (file.status === "kept" && !file.owned);
  }

  async function resolve(location: Location, action: "keep" | "archive") {
    if (busy || (action === "archive" && (!decision || stale))) return;
    const archive = decision;
    saving = true;
    error = "";

    const saved = await environment.resolveSkill(
      location.workerId,
      location.file,
      action,
      archive?.revision ?? environment.snapshot.revision,
    );

    if (!saved) error = environment.error || "Canopy couldn’t save your choice. Refresh the status and try again.";
    else if (action === "archive" && archive) {
      lastArchive = archive;
      decision = undefined;
    }

    saving = false;

    if (saved) {
      await tick();
      details?.focus();
    }
  }
</script>

<Dialog
  bind:open
  title={decision ? "Use library version?" : `Sync details for “${skillName}”`}
  dismissible={!busy}
  onexited={restoreFocus}
  stickyHeader
>
  <div class="grid min-w-0 gap-4 text-base sm:text-sm">
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if decision}
      <div class="grid gap-1">
        <p>
          Canopy moves this {decision.file.localLink ? "link" : "directory"} to an archive on {decision.computer}. It
          then installs the library version in its place.
        </p>
        <p class="font-mono text-sm wrap-anywhere select-text">{decision.file.path}</p>
        {#if decision.file.localLink}<p>The linked directory stays where it is.</p>
        {:else}<p>Links to this directory may stop working.</p>{/if}
      </div>
      {@render recovery(decision.file)}
      {#if stale && !saving}<Alert>The copy or its assignment changed. Go back to review the latest status.</Alert>{/if}
      <div class="flex flex-wrap justify-end gap-2" bind:this={confirmActions}>
        <Button disabled={saving} onclick={back}>Back</Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={busy || stale}
          onclick={() => decision && resolve(decision, "archive")}>Use library version</Button
        >
      </div>
    {:else}
      <div class="grid min-w-0 gap-4" tabindex="-1" bind:this={details}>
        {#if lastArchive}
          <div class="grid gap-2">
            <p role="status">
              {outcome === "installed"
                ? `Installed the library version on ${lastArchive.computer}.`
                : outcome === "archived"
                  ? `Archived the local copy on ${lastArchive.computer}.`
                  : outcome === "unconfirmed"
                    ? `Canopy couldn’t confirm the archive on ${lastArchive.computer}. Check the recovery location on that computer.`
                    : `Archiving the local copy on ${lastArchive.computer}…`}
            </p>
            {#if outcome !== "pending"}{@render recovery(lastArchive.file)}{/if}
          </div>
        {/if}
        {#each workers as { worker, files } (worker.workerId)}
          <section class="grid min-w-0 gap-2">
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 class="font-semibold wrap-anywhere">{worker.name}</h3>
              {#if worker.online && !current(worker)}
                <Button size="sm" variant="ghost" disabled={busy} onclick={() => environment.refresh()}
                  >Refresh status</Button
                >
              {/if}
            </div>
            {#if !worker.online}<p class="text-muted">Reconnect this computer to make changes.</p>
            {:else if !current(worker)}<p class="text-muted">
                Canopy needs a current sync report to make changes.
              </p>{/if}
            <div class="grid min-w-0 gap-3">
              {#each files as file (file.targetId)}
                {#if localCopyIssue(file)}
                  {@const waiting = waitingForArchive(worker.workerId, file)}
                  <div class="grid min-w-0 gap-1">
                    <p class="font-medium">{skillLocation(file)}</p>
                    <p class="font-mono text-sm wrap-anywhere text-muted select-text">{file.path}</p>
                    {#if !waiting}
                      <p role={file.status === "kept" ? "status" : undefined}>
                        {file.status === "kept"
                          ? "Canopy is keeping this local copy."
                          : `A local ${file.localLink ? "link" : "directory"} blocks the library version.`}
                      </p>
                      <div class="flex flex-wrap gap-2">
                        {#if (file.status === "drift" && file.observedChecksum) || canKeepBlockedSkill(file)}
                          <Button
                            size="sm"
                            disabled={busy || !current(worker)}
                            onclick={() => resolve({ workerId: worker.workerId, file }, "keep")}>Keep local copy</Button
                          >
                        {/if}
                        {#if canArchive(file)}
                          <Button
                            size="sm"
                            disabled={busy || !current(worker)}
                            onclick={() => reviewArchive(worker, file)}>Use library version</Button
                          >
                        {/if}
                      </div>
                      {#if !canArchive(file)}
                        <p class="text-muted">
                          Move this {file.localLink ? "link" : "directory"} out of the skills directory to use the library
                          version.
                        </p>
                      {/if}
                    {/if}
                  </div>
                {:else}
                  <ComputerSkillLocation {file} {busy} />
                {/if}
              {/each}
            </div>
            {#if files.some((file) => !localCopyIssue(file))}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onclick={() => {
                    open = false;
                    oncomputer(worker.workerId);
                  }}>Review on computer</Button
                >
              </div>
            {/if}
          </section>
        {:else}
          {#if !lastArchive}<p>No sync issues reported.</p>{/if}
        {/each}
      </div>
    {/if}
  </div>
</Dialog>

{#snippet recovery(file: EnvironmentSkillStatus)}
  <div class="grid min-w-0 gap-1">
    <p class="font-medium">Recovery location</p>
    <div class="flex min-w-0 items-start gap-2">
      <p class="min-w-0 flex-1 font-mono text-sm wrap-anywhere select-text">{archiveLocation(file)}</p>
      <CopyButton text={archiveLocation(file)} label="Copy recovery location" />
    </div>
  </div>
{/snippet}
