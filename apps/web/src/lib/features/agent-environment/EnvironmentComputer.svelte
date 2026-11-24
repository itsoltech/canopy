<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ComputerInstructions from "./ComputerInstructions.svelte";
  import ComputerPlugins from "./ComputerPlugins.svelte";
  import ComputerSkills from "./ComputerSkills.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let {
    worker,
    state: environment,
    onadd,
    class: className,
  }: {
    worker: ui.EnvironmentWorker;
    state: EnvironmentState;
    onadd?: (name: string) => void;
    class?: ClassValue;
  } = $props();

  function issues(files: readonly { status: string }[] = []) {
    return files.filter((f) => f.status === "drift" || f.status === "error").length;
  }
</script>

<div class={["settings-stack", className]}>
  {#if worker.compositionError}<Alert tone="error">{worker.compositionError}</Alert>
  {:else if !worker.supported}<Alert tone="warning">Update this worker to sync its agent environment.</Alert>{/if}
  {#if !worker.online}<Alert>This computer is offline. Reconnect it to review current files and make changes.</Alert
    >{/if}
  <ComputerSkills {worker} {environment} {onadd} />
  <div class="grid min-w-0 divide-y divide-divider border-y border-divider">
    <Disclosure class="py-3">
      {#snippet summary()}<div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-medium">Instruction files and preview</span>
          {@render attention(issues(worker.report?.files))}
        </div>{/snippet}
      <ComputerInstructions {worker} {environment} />
    </Disclosure>
    <Disclosure class="py-3">
      {#snippet summary()}<div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-medium">Plugins</span>
          {@render attention(issues(worker.report?.plugins))}
        </div>{/snippet}
      <ComputerPlugins class="pt-3" {worker} {environment} />
    </Disclosure>
    <Disclosure class="py-3">
      {#snippet summary()}<span class="font-medium">Computer tags</span>{/snippet}
      <div class="flex flex-wrap items-center gap-2 pt-3">
        {#each worker.automaticTags as tag (tag)}<Badge class="max-w-full break-all whitespace-normal">{tag}</Badge
          >{/each}
        {#each worker.manualTags as tag (tag)}<Badge tone="sky" class="max-w-full break-all whitespace-normal"
            >{tag}</Badge
          >{/each}
        <ButtonLink size="sm" href={`/settings/workers/${encodeURIComponent(worker.workerId)}#topic-tags`}
          >Edit tags</ButtonLink
        >
      </div>
    </Disclosure>
  </div>
</div>

{#snippet attention(count: number)}
  {#if count}<Badge tone="amber">{count === 1 ? "1 issue" : `${count} issues`}</Badge>{/if}
{/snippet}
