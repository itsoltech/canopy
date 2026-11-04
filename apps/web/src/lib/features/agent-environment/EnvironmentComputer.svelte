<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import TagInput from "./TagInput.svelte";
  import InstructionPreview from "./InstructionPreview.svelte";
  import InstructionDiff from "./InstructionDiff.svelte";
  import ComputerSkills from "./ComputerSkills.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let {
    worker,
    state: environment,
    class: className,
  }: { worker: ui.EnvironmentWorker; state: EnvironmentState; class?: ClassValue } = $props();

  let tags = $state(untrack(() => [...worker.manualTags]));
  let previousTags = untrack(() => JSON.stringify(worker.manualTags));
  const pending = $derived(!worker.report || worker.report.revision !== worker.desiredRevision);
  const problems = $derived(worker.report?.files.filter((f) => f.status === "drift" || f.status === "error") ?? []);
  const kept = $derived(worker.report?.files.some((f) => f.status === "kept"));

  $effect(() => {
    const current = JSON.stringify(worker.manualTags);

    if (current !== previousTags) {
      if (JSON.stringify(untrack(() => tags)) === previousTags) tags = [...worker.manualTags];
      previousTags = current;
    }
  });
</script>

<div class={["grid min-w-0 gap-6", className]}>
  <div class="flex flex-wrap gap-1.5" aria-label="Detected computer tags">
    {#each worker.automaticTags as tag (tag)}<Badge>{tag}</Badge>{/each}
  </div>
  <div class="grid gap-3">
    <TagInput
      label="Your tags"
      name="manual-worker-tags"
      bind:value={tags}
      workers={environment.snapshot.workers}
      automatic={false}
      description="Add your own groups. Detected tags above are maintained automatically."
    />
    <div>
      <Button
        size="sm"
        disabled={environment.busy || JSON.stringify(tags) === JSON.stringify(worker.manualTags)}
        onclick={() => environment.tags(worker.workerId, tags)}>Save tags</Button
      >
    </div>
  </div>
  {#if worker.compositionError}<Alert tone="error"
      >{worker.compositionError} The last synced files have been preserved.</Alert
    >
  {:else if !worker.supported}<Alert tone="warning">Update this worker to sync its agent environment.</Alert>
  {:else if !worker.online}<Alert>Offline. This computer will receive the latest instructions when it reconnects.</Alert
    >
  {:else if pending}<Alert>Waiting for this computer to report the saved instructions.</Alert>
  {:else if kept}<Alert
      >Local instructions are kept on this computer. Compare versions below to return to the library.</Alert
    >
  {:else if problems.length === 0}<p class="text-base text-emerald-700 sm:text-sm dark:text-emerald-400">
      Up to date · New agent sessions use the saved instructions.
    </p>{/if}
  <InstructionPreview {worker} draft={environment.draft} />
  <section aria-label="Files on this computer" class="grid min-w-0 gap-4">
    <h3 class="text-base font-semibold text-balance">Files on this computer</h3>
    {#each worker.report?.files ?? [] as file (file.targetId)}
      <div class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
        <div class="flex flex-wrap items-center gap-2 text-base sm:text-sm">
          <p class="min-w-0 flex-1 font-mono break-all">{file.path || "Instruction destinations"}</p>
          <Badge
            tone={file.status === "applied"
              ? "emerald"
              : file.status === "error"
                ? "rose"
                : file.status === "drift"
                  ? "amber"
                  : "neutral"}>{file.status}</Badge
          >
        </div>
        {#if file.status === "drift" || file.status === "kept"}
          <Disclosure open={file.status === "drift"}>
            {#snippet summary()}<div class="text-base sm:text-sm">Compare versions</div>{/snippet}
            <InstructionDiff
              class="pt-4"
              {file}
              busy={environment.busy || !worker.online || pending}
              expected={worker.preview.find(
                (i) => i.harness === file.harness && (file.scope === "device" ? i.deviceHome : i.platformHome),
              )?.content ?? ""}
              onresolve={(action) => environment.resolve(file, action)}
            />
          </Disclosure>
        {:else if file.status === "error"}<Alert tone="error">{file.detail}</Alert>{/if}
      </div>
    {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        Assigned files appear here after the worker's first sync.
      </p>{/each}
  </section>
  <ComputerSkills {worker} {environment} />
</div>
