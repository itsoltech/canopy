<script lang="ts">
  import { ui, type EnvironmentSkillStatus } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import ComputerSkillRow from "./ComputerSkillRow.svelte";
  import {
    agentLabel,
    awaitingArchive,
    archiveLocation,
    canArchive,
    canImportLocalSkill,
    computerSkills,
    type SkillLibraryEntry,
  } from "./computer-skills.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let {
    worker,
    environment,
    library,
    onarchive,
    onadd,
    busy = false,
    class: className,
  }: {
    worker: ui.EnvironmentWorker;
    environment?: EnvironmentState;
    library?: readonly SkillLibraryEntry[] | undefined;
    onarchive?: ((file: EnvironmentSkillStatus) => Promise<boolean>) | undefined;
    onadd?: ((file: EnvironmentSkillStatus, revision: bigint) => void) | undefined;
    busy?: boolean;
    class?: ClassValue;
  } = $props();

  const entries = $derived(
    library ??
      environment?.snapshot.skills.map((s) => ({
        id: s.id,
        name: s.name,
        artifactName: s.artifact?.name ?? "",
      })),
  );

  const files = $derived(worker.report?.skills ?? []);
  const groups = $derived(computerSkills(files, entries));
  const pending = $derived(!worker.report || worker.report.revision !== worker.desiredRevision);
  const unavailable = $derived(!worker.skillsSupported || !worker.online || !!worker.compositionError || pending);
  const saving = $derived(Boolean(busy || environment?.busy));
  const blocked = $derived(unavailable || saving);
  const revision = $derived(environment?.snapshot.revision ?? worker.desiredRevision);
  const importAvailable = $derived(!unavailable && worker.localSkillImportSupported);

  type Decision = { name: string; revision: bigint; workerId: string } & (
    | { action: "disable"; skill: ui.LibrarySkill }
    | { action: "archive" | "overwrite"; file: EnvironmentSkillStatus }
  );

  let decision = $state.raw<Decision>();
  let confirming = $state(false);
  let submitting = $state(false);
  let lastArchive = $state.raw<EnvironmentSkillStatus>();
  const archiveReport = $derived(files.find((file) => lastArchive && file.targetId === lastArchive.targetId));
  const archivePending = $derived(!!lastArchive && !!archiveReport && awaitingArchive(archiveReport, lastArchive));

  const archiveConfirmed = $derived(
    !pending &&
      !worker.compositionError &&
      (!!archiveReport?.owned ||
        archiveReport?.status === "removed" ||
        (!archiveReport && worker.report?.skillInventoryScanned)),
  );

  const stale = $derived.by(() => {
    if (!decision || decision.revision !== revision || decision.workerId !== worker.workerId || unavailable)
      return true;

    if (decision.action === "disable") return !worker.skillIds.includes(decision.skill.id);
    const original = decision.file;
    const current = files.find((f) => f.targetId === original.targetId);

    return (
      !current ||
      current.status !== original.status ||
      current.owned !== original.owned ||
      current.observedChecksum !== original.observedChecksum ||
      current.archiveToken !== original.archiveToken ||
      current.desiredChecksum !== original.desiredChecksum ||
      current.path !== original.path
    );
  });

  function confirmFile(name: string, file: EnvironmentSkillStatus, action: "archive" | "overwrite") {
    if (blocked) return;
    decision = { action, file, name, revision, workerId: worker.workerId };
    confirming = true;
  }

  async function resolve(file: EnvironmentSkillStatus, action: "archive" | "keep" | "overwrite" | "import") {
    if (blocked) return;

    if (action === "archive") {
      if (!canArchive(file)) return;

      lastArchive = undefined;

      if (onarchive) {
        if (await onarchive(file)) lastArchive = file;

        return;
      }
    }

    if (!environment) return;

    const saved = await environment.resolveSkill(worker.workerId, file, action, revision);

    if (saved && action === "archive") lastArchive = file;
  }

  async function confirm() {
    if (!decision || stale || saving || submitting) return;
    submitting = true;

    if (decision.action === "disable" && environment) {
      const skill = decision.skill;
      const workerId = decision.workerId;

      if (await environment.excludeSkill(skill, [workerId], decision.revision))
        environment.notice = `Disabled “${skill.name}” on ${worker.name}.`;
    } else if (decision.action !== "disable") {
      await resolve(decision.file, decision.action);
    }

    confirming = false;
    submitting = false;
  }

  const buttonLabel = $derived(
    decision?.action === "archive"
      ? "Archive local copy"
      : decision?.action === "overwrite"
        ? decision.file.desiredChecksum
          ? "Use library version"
          : "Remove managed files"
        : "Disable skill",
  );
</script>

<section class={["grid min-w-0 gap-4", className]} aria-label="Skills on this computer">
  <h3 class="text-base font-semibold">Skills</h3>
  {#if !worker.skillsSupported && worker.supported}
    <Alert tone="warning">Update the worker on this computer to sync skills.</Alert>
  {:else if worker.skillsSupported && worker.online && !worker.compositionError}
    {#if pending}
      <p class="text-sm text-muted" role="status">Waiting for the latest skill report…</p>
    {:else if !worker.report?.skillInventoryScanned}
      <p class="text-sm text-muted">
        The worker did not report a complete local skill list. Check access to the CLI directories and the worker
        version.
      </p>
    {/if}
    {#if onadd && !pending && !worker.localSkillImportSupported && groups.some((group) => group.missingFromLibrary && group.files.some(canImportLocalSkill))}
      <p class="text-sm text-muted">Update Canopy on this computer to add local skills to the library.</p>
    {/if}
  {/if}
  {#if lastArchive}
    <div class="grid gap-1 text-sm">
      <p role="status">
        {archiveConfirmed
          ? `Archived “${lastArchive.localName}”.`
          : archiveReport && !archivePending && archiveReport.status === "error"
            ? `Could not confirm the archive of “${lastArchive.localName}”. Review its location below.`
            : `Archive requested for “${lastArchive.localName}”.`}
      </p>
      <Disclosure>
        {#snippet summary()}<span class="text-muted">Recovery location</span>{/snippet}
        <div class="flex min-w-0 items-start gap-2 pt-2">
          <p class="min-w-0 flex-1 font-mono wrap-anywhere select-text">{archiveLocation(lastArchive)}</p>
          <CopyButton text={archiveLocation(lastArchive)} label="Copy recovery location" />
        </div>
      </Disclosure>
    </div>
  {/if}
  {#if groups.length}
    <div class="divide-y divide-divider border-y border-divider text-base sm:text-sm">
      {#each groups as group (group.key)}
        {@const skill = environment?.snapshot.skills.find((s) => s.id === group.skillId)}
        <ComputerSkillRow
          {group}
          busy={blocked}
          waitingTarget={archivePending ? lastArchive?.targetId : undefined}
          onadd={onadd && importAvailable ? (file) => onadd?.(file, revision) : undefined}
          onarchive={environment || onarchive ? (file) => confirmFile(group.name, file, "archive") : undefined}
          onresolve={environment
            ? (file, action) => {
                if (action === "overwrite") confirmFile(group.name, file, action);
                else void resolve(file, action);
              }
            : undefined}
          ondisable={skill && worker.skillIds.includes(skill.id)
            ? () => {
                decision = { action: "disable", skill, name: skill.name, revision, workerId: worker.workerId };
                confirming = true;
              }
            : undefined}
        />
      {/each}
    </div>
  {/if}
  {#if !groups.length && worker.report && !pending && worker.skillsSupported && !worker.compositionError}
    <p class="text-sm text-muted">
      {worker.skillIds.length
        ? "The worker has not reported any assigned skill locations."
        : worker.report.skillInventoryScanned
          ? "No local or assigned skills found."
          : "No skills assigned to this computer."}
    </p>
  {/if}
</section>

<Dialog bind:open={confirming} title={`${buttonLabel}?`} dismissible={!saving && !submitting}>
  {#if decision}
    <div class="grid min-w-0 gap-3 text-base sm:text-sm">
      {#if decision.action === "disable"}
        <p>
          This turns off “{decision.name}” for all assigned agents on {worker.name}. Canopy removes its installed files
          when the computer syncs. Local copies stay on disk.
        </p>
      {:else}
        {#if decision.action === "archive"}
          <p>
            Move the local copy of “{decision.file.localName}” out of the {agentLabel(decision.file.harness)} skills directory
            on {worker.name}.
          </p>
        {:else if decision.file.desiredChecksum}
          <p>
            Replace local edits to “{decision.name}” at this location with the assigned library version. This discards
            edits to managed files.
          </p>
        {:else}
          <p>Remove the managed files for “{decision.name}” from this location, including your local edits.</p>
        {/if}
        <p class="font-mono text-sm wrap-anywhere select-text">{decision.file.path}</p>
        {#if decision.action === "archive"}
          <p>
            {decision.file.desiredChecksum
              ? "Canopy installs the assigned library version in its place."
              : "New sessions that load skills from this directory no longer find this copy."}
          </p>
          {#if decision.file.localLink}
            <p>Only the link moves. Its target stays in place.</p>
          {:else}
            <p>Links to this directory may stop working when it moves.</p>
          {/if}
          <div>
            <p class="text-sm font-medium">Recovery location</p>
            <div class="flex min-w-0 items-start gap-2">
              <p class="min-w-0 flex-1 font-mono text-sm wrap-anywhere select-text">{archiveLocation(decision.file)}</p>
              <CopyButton text={archiveLocation(decision.file)} label="Copy recovery location" />
            </div>
          </div>
        {/if}
      {/if}
      {#if confirming && stale && !saving && !submitting}
        <Alert>Close this dialog and review the latest report before making changes.</Alert>
      {/if}
      <div class="flex flex-wrap justify-end gap-2">
        <Button data-autofocus disabled={saving || submitting} onclick={() => (confirming = false)}>Cancel</Button>
        <Button variant="danger" disabled={stale} loading={saving || submitting} onclick={confirm}>{buttonLabel}</Button
        >
      </div>
    </div>
  {/if}
</Dialog>
