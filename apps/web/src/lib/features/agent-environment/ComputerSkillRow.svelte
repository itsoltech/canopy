<script lang="ts">
  import type { EnvironmentSkillStatus } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SkillDiff from "./SkillDiff.svelte";
  import {
    agentLabel,
    canArchive,
    fileState,
    locationSummary,
    needsAttention,
    skillLocation,
    skillProblem,
    type ComputerSkill,
  } from "./computer-skills.ts";

  let {
    group,
    busy,
    waitingTarget,
    onarchive,
    onresolve,
    ondisable,
    onadd,
  }: {
    group: ComputerSkill;
    waitingTarget?: string | undefined;
    busy: boolean;
    onarchive?: ((file: EnvironmentSkillStatus) => void) | undefined;
    onresolve?: ((file: EnvironmentSkillStatus, action: "keep" | "overwrite" | "import") => void) | undefined;
    ondisable?: (() => void) | undefined;
    onadd?: (() => void) | undefined;
  } = $props();

  const locations = $derived(locationSummary(group.files));
  const first = $derived(group.files[0]!);
  const synced = $derived(needsAttention(first) ? group.files.filter((file) => file.status === "applied") : []);
  const main = $derived(synced.length ? group.files.filter((file) => file.status !== "applied") : group.files);

  const stateLabel = $derived(
    waitingTarget && first.targetId === waitingTarget
      ? "Archiving copy…"
      : needsAttention(first) || first.status === "kept"
        ? fileState(first)
        : group.overlappingAgents.length
          ? "Name in multiple directories"
          : group.membership,
  );
</script>

<Disclosure align="center" class="min-w-0" summaryClass="py-3">
  {#snippet summary()}
    <span class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span class="min-w-0 font-medium wrap-anywhere">{group.name}</span>
      {#if stateLabel}
        <span
          class={[
            "text-sm wrap-anywhere",
            first.status === "error" && first.targetId !== waitingTarget
              ? "text-rose-700 dark:text-rose-400"
              : first.status === "drift" && first.targetId !== waitingTarget
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted",
          ]}>{stateLabel}</span
        >
      {/if}
    </span>
    {#if locations}<span class="mt-0.5 block text-sm text-muted">{locations}</span>{/if}
  {/snippet}
  <div class="grid min-w-0 gap-3 pb-4 pl-5">
    {#if group.overlappingAgents.length}
      <p class="text-sm">
        {group.overlappingAgents.join(", ")} can find this name in more than one personal CLI directory.
      </p>
    {/if}
    {#if group.membership && group.membership !== stateLabel}
      <p class="text-sm text-muted">{group.membership}</p>
    {/if}
    {#each main as file}{@render location(file)}{/each}
    {#if synced.length}
      <Disclosure>
        {#snippet summary()}<span class="text-sm"
            >Show {synced.length === 1 ? "1 synced location" : `${synced.length} synced locations`}</span
          >{/snippet}
        <div class="grid min-w-0 gap-3 pt-3">
          {#each synced as file}{@render location(file)}{/each}
        </div>
      </Disclosure>
    {/if}
    {#if ondisable}
      <div><Button size="sm" disabled={busy} onclick={ondisable}>Disable on this computer</Button></div>
    {:else if onadd && group.missingFromLibrary}
      <div><Button size="sm" onclick={onadd}>Add to library</Button></div>
    {/if}
  </div>
</Disclosure>

{#snippet location(file: EnvironmentSkillStatus)}
  {@const waiting = !!waitingTarget && file.targetId === waitingTarget}
  {@const archiveUnavailable = file.status === "local" && !file.archiveToken && !!file.detail}
  <div class="grid min-w-0 gap-2 border-l border-divider pl-3">
    {#if file.path}
      <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="font-medium">{skillLocation(file.scope)} · {agentLabel(file.harness)}</span>
        <span class="text-sm text-muted"
          >{waiting ? "Archiving copy…" : fileState(file)}{file.status !== "local" && file.localLink
            ? " · Local link"
            : ""}{file.version ? ` · Assigned v${file.version}` : ""}</span
        >
      </p>
      <p class="font-mono text-sm leading-5 wrap-anywhere select-text">{file.path}</p>
    {/if}
    {#if !waiting && archiveUnavailable}
      <p class="text-sm">Canopy can’t archive this copy. {skillProblem(file)}</p>
    {:else if !waiting && needsAttention(file)}
      <p class="text-sm text-pretty">{skillProblem(file)}</p>
    {:else if file.status === "kept"}
      <p class="text-sm text-muted">Canopy keeps this copy until the local files or assignment change.</p>
    {/if}
    {#if !waiting && (file.status === "error" || archiveUnavailable) && file.detail}
      <Disclosure>
        {#snippet summary()}<span class="text-sm text-muted">Show worker details</span>{/snippet}
        <div class="flex min-w-0 items-start gap-2 pt-2">
          <p class="min-w-0 flex-1 text-sm wrap-anywhere select-text">{file.detail}</p>
          <CopyButton text={file.detail} label="Copy worker details" />
        </div>
      </Disclosure>
    {/if}
    {#if !waiting && (file.status === "drift" || file.status === "kept")}
      <SkillDiff
        {file}
        expected={file.desiredFiles}
        {busy}
        onresolve={onresolve ? (action) => onresolve?.(file, action) : undefined}
      />
    {/if}
    {#if canArchive(file) && onarchive}
      <div><Button size="sm" disabled={busy} onclick={() => onarchive?.(file)}>Archive local copy</Button></div>
    {/if}
  </div>
{/snippet}
