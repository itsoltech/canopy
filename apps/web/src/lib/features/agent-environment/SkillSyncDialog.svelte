<script lang="ts">
  import { tick } from "svelte";
  import type { EnvironmentSkillStatus, ui } from "@canopy/contracts";
  import { assignedWorkers, canRemoveSkillConflict, isLocalSkillConflict } from "@canopy/domain/environment-library";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SkillConflictImport, { conflictImportSources } from "./SkillConflictImport.svelte";
  import SkillExcludeReview from "./SkillExcludeReview.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { awaitingArchive } from "./computer-skills.ts";
  import SkillArchiveReview from "./SkillArchiveReview.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import SkillArchiveStatus from "./SkillArchiveStatus.svelte";
  import SkillSyncLocations from "./SkillSyncLocations.svelte";
  import {
    archiveGroups,
    currentReport,
    sameArchiveGroup,
    recordArchives,
    skillIssues,
    useLibraryVersion,
    type SyncComputer,
  } from "./skill-sync.ts";

  let { environment, oncomputer }: { environment: EnvironmentState; oncomputer: (id: string) => void } = $props();

  const reviewTitles = {
    use: "Use the Canopy version?",
    import: "Use a local copy in Canopy",
    remove: "Remove from Canopy?",
    exclude: "Exclude computers from sync",
  };

  type Action = keyof typeof reviewTitles;

  type Witness = { workerId: string; file: EnvironmentSkillStatus };

  type Review = { revision: bigint } & (
    | { action: "import"; sources: SyncComputer[]; skill: ui.LibrarySkill }
    | { action: "use"; groups: SyncComputer[]; remaining: number }
    | { action: "remove"; witness: Witness }
    | { action: "exclude"; computers: ui.EnvironmentWorker[]; skill: ui.LibrarySkill }
  );

  let open = $state(false);
  let skillId = $state("");
  let skillName = $state("");
  let review = $state.raw<Review>();
  let selected = $state<string[]>([]);
  let submitted = $state.raw<SyncComputer[]>([]);
  let showResult = $state(false);
  let saving = $state(false);
  let failure = $state("");
  let failureDetail = $state("");
  let body = $state<HTMLDivElement>();

  const revision = $derived(environment.snapshot.revision);
  const skill = $derived(environment.snapshot.skills.find((s) => s.id === skillId));

  const assigned = $derived(
    skill ? assignedWorkers(environment.snapshot.workers, skill.selector, skill.overrides) : [],
  );

  const issues = $derived(skillIssues(assigned, skillId));
  const archives = $derived(archiveGroups(issues, revision));
  const sources = $derived(conflictImportSources(issues, revision));
  const localConflicts = $derived(issues.filter(({ files }) => files.some(isLocalSkillConflict)));

  const witness = $derived.by(() => {
    for (const { worker, files } of issues) {
      const file = files.find(canRemoveSkillConflict);

      if (file && currentReport(worker, revision)) return { workerId: worker.workerId, file };
    }
  });

  const remainingIssues = $derived(
    issues.some(({ worker, files }) => {
      const previous = submitted.find((group) => group.worker.workerId === worker.workerId);

      return files.some((file) => !previous?.files.some((requested) => awaitingArchive(file, requested)));
    }),
  );

  const busy = $derived(saving || environment.busy);
  const stale = $derived(!!review && (!skill || review.revision !== revision || !stillValid(review)));
  const kept = $derived(issues.length > 0 && issues.every(({ files }) => files.every((f) => f.status === "kept")));

  const title = $derived(review ? reviewTitles[review.action] : `Sync “${skillName}”`);

  function stillValid(choice: Review) {
    if (choice.action === "use")
      return choice.groups
        .filter(({ worker }) => selected.includes(worker.workerId))
        .every((group) => sameArchiveGroup(group, archives));

    if (choice.action !== "remove") return true;
    const source = choice.witness;
    const group = issues.find(({ worker }) => worker.workerId === source.workerId);
    const file = group?.files.find((f) => f.targetId === source.file.targetId);

    return (
      !!group &&
      currentReport(group.worker, revision) &&
      !!file &&
      canRemoveSkillConflict(file) &&
      file.observedChecksum === source.file.observedChecksum &&
      file.desiredChecksum === source.file.desiredChecksum
    );
  }

  function restoreFocus() {
    requestAnimationFrame(() => {
      if (open || document.activeElement !== document.body) return;
      (
        document.getElementById(`environment-item-${skillId}`)?.querySelector<HTMLElement>("[data-item-focus]") ??
        document.getElementById("environment-add-skill")
      )?.focus();
    });
  }

  export function show(id: string) {
    const item = environment.snapshot.skills.find((entry) => entry.id === id);

    if (!item) return;

    if (skillId !== id) submitted = [];
    showResult = false;
    skillId = id;
    skillName = item.name;
    review = undefined;
    failure = "";
    open = true;
  }

  function focusBody() {
    void tick().then(() => body?.focus());
  }

  function choose(action: Action) {
    if (busy || !skill) return;
    failure = "";

    if (action === "use") {
      review = {
        action,
        revision,
        groups: archives,
        remaining: issues.reduce((n, g) => n + g.files.length, 0) - archives.reduce((n, g) => n + g.files.length, 0),
      };
      selected = archives.map(({ worker }) => worker.workerId);
    } else if (action === "import") {
      review = { action, revision, sources, skill };
    } else if (action === "exclude") {
      review = { action, revision, computers: assigned, skill };
    } else if (witness) review = { action, revision, witness };
    focusBody();
  }

  function back() {
    const action = review?.action;
    review = undefined;
    failure = "";
    void tick().then(() => (body?.querySelector<HTMLButtonElement>(`[data-choice="${action}"]`) ?? body)?.focus());
  }

  async function confirm() {
    const choice = review;

    if (
      !choice ||
      (choice.action !== "use" && choice.action !== "remove") ||
      busy ||
      stale ||
      (choice.action === "use" && !selected.length)
    )
      return;
    saving = true;
    failure = "";

    try {
      if (choice.action === "use") {
        const failed: string[] = [];

        for (const group of choice.groups.filter(({ worker }) => selected.includes(worker.workerId))) {
          if (await useLibraryVersion(environment, skillId, group, choice.revision)) {
            submitted = recordArchives(submitted, group);
          } else {
            failed.push(group.worker.name);
            failureDetail = environment.error;
          }
        }

        review = undefined;
        showResult = submitted.length > 0;

        if (failed.length)
          failure = `Couldn’t request installation on ${failed.join(", ")}. Review the latest status and try again.`;
        focusBody();
      } else {
        const saved = await environment.resolveSkill(
          choice.witness.workerId,
          choice.witness.file,
          "keep-local-and-remove",
          choice.revision,
        );

        if (saved) {
          environment.notice = `Removed “${skillName}” from the shared library.`;
          open = false;
        } else {
          failure = "Couldn’t save this choice. Go back to review the latest status.";
          failureDetail = environment.error;
        }
      }
    } finally {
      saving = false;
    }
  }

  function openComputer(id: string) {
    open = false;
    oncomputer(id);
  }
</script>

<Dialog bind:open {title} dismissible={!busy} onexited={restoreFocus} stickyHeader>
  <div bind:this={body} tabindex="-1" class="grid min-w-0 gap-4 text-base/6 outline-none sm:text-sm/5">
    {#if failure}
      <Alert tone="error">{failure}</Alert>
      {#if failureDetail}<Disclosure
          >{#snippet summary()}Show details{/snippet}
          <p class="pt-2 select-text">{failureDetail}</p></Disclosure
        >{/if}
    {/if}
    {#if review?.action === "import"}
      <SkillConflictImport
        {environment}
        skill={review.skill}
        revision={review.revision}
        sources={review.sources}
        onback={back}
        onsubmitted={(group) => {
          submitted = recordArchives(submitted, group);
          review = undefined;
          showResult = true;
          focusBody();
        }}
      />
    {:else if review?.action === "exclude"}
      <SkillExcludeReview
        {environment}
        skill={review.skill}
        computers={review.computers}
        revision={review.revision}
        bind:saving
        onback={back}
        ondone={() => (open = false)}
        oncomputer={openComputer}
      />
    {:else if review}
      {#if review.action === "use"}
        <SkillArchiveReview {skillName} groups={review.groups} remaining={review.remaining} {busy} bind:selected />
      {:else}
        <p>
          Remove “{skillName}” from the shared library. Folders and links you installed yourself stay on your computers.
        </p>
        <p>Canopy uninstalls its unedited copies from all assigned computers when they next sync.</p>
      {/if}
      {#if stale && !saving}<Alert>The skill or computer changed. Go back to review the latest status.</Alert>{/if}
      <div class="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} onclick={back}>Back</Button>
        <Button
          variant={review.action === "remove" ? "danger" : "primary"}
          loading={saving}
          disabled={busy || stale || (review.action !== "remove" && !selected.length)}
          onclick={confirm}
        >
          {review.action === "use" ? "Use Canopy version" : "Remove from Canopy"}
        </Button>
      </div>
    {:else if showResult}
      <SkillArchiveStatus groups={submitted} workers={environment.snapshot.workers} />
      <div class="flex flex-wrap justify-end gap-2">
        {#if remainingIssues}
          <Button
            onclick={() => {
              showResult = false;
              focusBody();
            }}>Review remaining copies</Button
          >
        {/if}
        <Button onclick={() => (open = false)}>Done</Button>
      </div>
    {:else}
      {#if issues.length}
        <p class="text-muted">
          {#if localConflicts.length === 1}Local copies on {localConflicts[0]!.worker.name} block this skill from syncing.
          {:else if localConflicts.length}Local copies on {localConflicts.length} computers block this skill from syncing.
          {:else if kept}Your computers are using local copies of this skill.
          {:else}This skill needs attention on {issues.length === 1
              ? issues[0]!.worker.name
              : `${issues.length} computers`}.{/if}
        </p>
        <div class="grid divide-y divide-divider overflow-hidden rounded-xl border border-divider">
          {#if archives.length}
            {@render option(
              "use",
              "arrow-path",
              "Use the Canopy version",
              "Back up local copies before installing the library version.",
            )}
          {/if}
          {#if sources.length}
            {@render option(
              "import",
              "folder-plus",
              "Use a local copy in Canopy",
              "Choose which local copy to save as the library version.",
            )}
          {/if}
          {#if witness}
            {@render option("remove", "folder", "Keep local copies", "Remove the skill from your shared library.")}
          {/if}
          {@render option(
            "exclude",
            "computer-desktop",
            "Exclude computers from sync",
            "Stop syncing this skill on selected computers.",
          )}
        </div>
        {#if !archives.length && !witness && issues.some(({ worker }) => !currentReport(worker, revision))}
          <p class="text-muted">Reconnect affected computers and refresh their status to review local copies.</p>
          <div><Button size="sm" disabled={busy} onclick={() => environment.refresh()}>Refresh status</Button></div>
        {/if}
        {#if !localConflicts.length && !kept}
          {#each issues as { worker } (worker.workerId)}
            <div>
              <Button size="sm" disabled={busy} onclick={() => openComputer(worker.workerId)}
                >Review on {worker.name}</Button
              >
            </div>
          {/each}
        {/if}
        <SkillSyncLocations groups={issues} {busy} oncomputer={openComputer} />
      {:else}<p role="status">
          {skill ? "No sync issues reported." : "This skill is no longer in your library."}
        </p>{/if}
      {#if submitted.length}
        <Disclosure
          >{#snippet summary()}Previous installation{/snippet}
          <div class="pt-2"><SkillArchiveStatus groups={submitted} workers={environment.snapshot.workers} /></div>
        </Disclosure>
      {/if}
    {/if}
  </div>
</Dialog>

{#snippet option(action: Action, icon: IconName, label: string, detail: string)}
  <button
    type="button"
    data-choice={action}
    disabled={busy}
    onclick={() => choose(action)}
    class="flex min-w-0 items-center gap-3 px-3.5 py-3 text-left focus-ring hover:bg-zinc-950/3 focus-visible:-outline-offset-2 dark:hover:bg-white/5"
  >
    <Icon name={icon} />
    <span class="grid min-w-0 flex-1 gap-0.5">
      <span class="font-medium">{label}</span>
      <span class="text-pretty text-muted">{detail}</span>
    </span>
    <Icon name="chevron-right" size="sm" />
  </button>
{/snippet}
