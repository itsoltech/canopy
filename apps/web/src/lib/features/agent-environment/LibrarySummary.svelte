<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { librarySummary } from "@canopy/domain/environment-library";
  import Button from "#lib/shared/ui/Button.svelte";
  import SkillInstall from "./SkillInstall.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let { environment, class: className }: { environment: EnvironmentState; class?: ClassValue } = $props();
  const summary = $derived(librarySummary(environment.snapshot, environment.workers));
  let ids = $state<string[]>([]);
</script>

<section
  aria-label="Library status"
  class={["grid min-w-0 gap-3 rounded-xl bg-zinc-950/3 p-4 dark:bg-white/4", className]}
>
  <p class="text-base text-pretty sm:text-sm">
    Your library is shared with your linked computers. Items are installed only on the computers you assign them to.
  </p>
  <div role="status" class="grid gap-1 text-base tabular-nums sm:text-sm">
    <p>{summary.skills}</p>
    <p>{summary.plugins}</p>
    <p>{summary.instructions}</p>
  </div>
  <div class:invisible={!summary.notInstalled.length} aria-hidden={!summary.notInstalled.length}>
    <Button
      size="sm"
      disabled={environment.busy || !summary.notInstalled.length}
      onclick={() => (ids = summary.notInstalled.map((s) => s.id))}>Install all not-installed skills on…</Button
    >
  </div>
</section>
<SkillInstall bind:ids {environment} />
