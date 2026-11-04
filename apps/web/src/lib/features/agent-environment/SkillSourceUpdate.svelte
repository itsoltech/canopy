<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import { SourceState } from "./source-state.svelte.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";

  let {
    skill,
    environment,
    class: className,
  }: { skill: ui.LibrarySkill; environment: EnvironmentState; class?: ClassValue } = $props();

  const controller = new SourceState(untrack(() => environment));
  let open = $state(false);
</script>

{#if skill.source}
  <div class={className}>
    <IconButton
      icon="arrow-path"
      label={skill.source.availableCommit ? "Review update" : "Check upstream"}
      size="sm"
      loading={controller.busy}
      disabled={environment.busy}
      onclick={() => {
        environment.error = "";
        open = true;
        void controller.check(skill.id);
      }}
    />
    <EnvironmentSheet
      bind:open
      title="Review skill update"
      steps={["Review upstream changes"]}
      busy={controller.busy || environment.busy}
      error={controller.error || skill.source.error || environment.error}
      submitLabel="Apply update and sync"
      submitDisabled={!controller.preview || controller.preview.source?.commit === skill.source.commit}
      onsave={async () => {
        await controller.apply(skill.id);
        if (!controller.preview) open = false;
      }}
    >
      {#snippet children()}
        {#if controller.preview && controller.preview.source?.commit !== skill.source?.commit}
          <div class="grid min-w-0 gap-4 rounded-xl p-4 ring-1 ring-zinc-950/10 dark:ring-white/10">
            <h4 class="text-base font-medium text-balance">Review upstream update</h4>
            <p class="font-mono text-base wrap-anywhere sm:text-sm">
              {skill.source?.commit.slice(0, 12)} → {controller.preview.source?.commit.slice(0, 12)}
            </p>
            {#if controller.preview.skills[0]?.artifact}<SkillSourceFiles
                artifact={controller.preview.skills[0].artifact}
                before={skill.artifact}
              />{/if}
            <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
              Apply approves this exact frozen candidate. Roll back from Library version in the skill editor.
            </p>
          </div>
        {:else if controller.preview}<p role="status" class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
            Up to date at this commit.
          </p>{:else}<p class="text-base text-muted sm:text-sm">
            {controller.busy ? "Checking upstream…" : "No preview available. Close this sheet and check again."}
          </p>{/if}
      {/snippet}
    </EnvironmentSheet>
  </div>
{/if}
