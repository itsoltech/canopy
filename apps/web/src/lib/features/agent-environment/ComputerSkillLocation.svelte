<script lang="ts">
  import type { EnvironmentSkillStatus } from "@canopy/contracts";
  import { canKeepBlockedSkill } from "@canopy/domain/environment-library";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SkillDiff from "./SkillDiff.svelte";
  import { canArchive, fileState, skillLocation, skillProblem } from "./computer-skills.ts";

  let {
    file,
    busy,
    waiting = false,
    onresolve,
    onarchive,
    onadd,
  }: {
    file: EnvironmentSkillStatus;
    busy: boolean;
    waiting?: boolean;
    onresolve?: ((file: EnvironmentSkillStatus, action: "keep" | "overwrite" | "import") => void) | undefined;
    onarchive?: ((file: EnvironmentSkillStatus) => void) | undefined;
    onadd?: (() => void) | undefined;
  } = $props();

  const pathId = $props.id();
  const conflict = $derived(file.status === "drift" && !file.owned);
  const keep = $derived(!!onresolve && (conflict || canKeepBlockedSkill(file)));
  const archive = $derived(canArchive(file) && !!onarchive);
  const unavailable = $derived(file.status === "local" && !file.archiveToken && !!file.detail);
  const version = $derived(file.version ? `v${file.version}` : "");

  const state = $derived.by(() => {
    if (waiting) return "Archiving copy…";

    if (conflict) return `Local ${file.localLink ? "link" : "folder"} blocks ${version || "sync"}`;

    if (file.localLink && file.status === "error") return "Local link";

    if (file.status === "applied" && version)
      return file.scope === "platform" ? `${version} installed` : `${version} installed by Canopy`;

    return [fileState(file), version && `${version} assigned`].filter(Boolean).join(" · ");
  });
</script>

<div class="min-w-0">
  {#if file.path}
    <p class="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span class="font-medium">{skillLocation(file)}</span>
      <span class="text-muted">{state}</span>
    </p>
    <p id={pathId} class="font-mono text-sm leading-5 wrap-anywhere text-muted select-text">{file.path}</p>
  {/if}
  {#if !waiting && (onadd || keep || archive)}
    <div class="mt-1 flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      {#if onadd}<Button
          size="sm"
          disabled={busy}
          aria-label={`Add to library from ${skillLocation(file)}`}
          aria-describedby={pathId}
          onclick={onadd}>Add to library</Button
        >{/if}
      {#if keep}<Button size="sm" disabled={busy} onclick={() => onresolve?.(file, "keep")}>Keep local copy</Button
        >{/if}
      {#if archive}<Button
          size="sm"
          variant={keep || onadd ? "ghost" : "secondary"}
          disabled={busy}
          onclick={() => onarchive?.(file)}>Archive local copy</Button
        >{/if}
    </div>
  {/if}
  {#if !waiting && (file.status === "error" || unavailable)}
    <p class="mt-1 text-sm text-pretty">{skillProblem(file)}</p>
    {#if file.detail}
      <Disclosure class="mt-1">
        {#snippet summary()}<span class="text-sm text-muted">Show worker details</span>{/snippet}
        <div class="flex min-w-0 items-start gap-2 pt-2">
          <p class="min-w-0 flex-1 text-sm wrap-anywhere select-text">{file.detail}</p>
          <CopyButton text={file.detail} label="Copy worker details" />
        </div>
      </Disclosure>
    {/if}
  {:else if conflict && !waiting && !archive}
    <p class="mt-1 text-sm text-muted">Move this folder on the computer to install the library version.</p>
  {/if}
  {#if !waiting && file.owned && (file.status === "drift" || file.status === "kept")}
    <SkillDiff
      class="mt-2"
      {file}
      expected={file.desiredFiles}
      {busy}
      onresolve={onresolve ? (action) => onresolve?.(file, action) : undefined}
    />
  {/if}
</div>
