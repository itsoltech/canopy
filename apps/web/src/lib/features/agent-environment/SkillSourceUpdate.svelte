<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import { SourceState } from "./source-state.svelte.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let {
    skill,
    environment,
    class: className,
  }: { skill: ui.LibrarySkill; environment: EnvironmentState; class?: ClassValue } = $props();

  const state = new SourceState(untrack(() => environment));
</script>

{#if skill.source}
  <div class={["grid min-w-0 gap-3", className]}>
    <p class="font-mono text-base wrap-anywhere text-zinc-500 sm:text-sm dark:text-zinc-400">
      {skill.source.url} · {skill.source.path || "root"} · {skill.source.commit.slice(0, 12)}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      {#if skill.source.availableCommit}<span
          class="text-base font-medium text-amber-700 sm:text-sm dark:text-amber-300">Update available</span
        >{/if}
      {#if skill.source.pinned}<span class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400"
          >Pinned · periodic updates paused</span
        >{:else}<span class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400"
          >{skill.source.autoUpdate ? "Automatic updates · scripts require review" : "Manual updates"}</span
        >{/if}
      <Button size="sm" loading={state.busy} disabled={environment.busy} onclick={() => state.check(skill.id)}
        >{skill.source.availableCommit ? "Review update" : "Check upstream"}</Button
      >
    </div>
    {#if state.error || skill.source.error}<Alert tone="warning">{state.error || skill.source.error}</Alert>{/if}
    {#if state.preview && state.preview.source?.commit !== skill.source.commit}
      <div class="grid min-w-0 gap-4 rounded-xl p-4 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <h4 class="text-base font-medium text-balance">Review upstream update</h4>
        <p class="font-mono text-base wrap-anywhere sm:text-sm">
          {skill.source.commit.slice(0, 12)} → {state.preview.source?.commit.slice(0, 12)}
        </p>
        {#if state.preview.skills[0]?.artifact}<SkillSourceFiles
            artifact={state.preview.skills[0].artifact}
            before={skill.artifact}
          />{/if}
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Apply approves this exact frozen candidate. Roll back from Library version in the skill editor.
        </p>
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" disabled={environment.busy} onclick={() => state.apply(skill.id)}
            >Apply update and sync</Button
          ><Button onclick={() => (state.preview = undefined)}>Close review</Button>
        </div>
      </div>
    {:else if state.preview}<p role="status" class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
        Up to date at this commit.
      </p>{/if}
  </div>
{/if}
