<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import InstructionPreview from "./InstructionPreview.svelte";
  import InstructionDiff from "./InstructionDiff.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let { worker, environment }: { worker: ui.EnvironmentWorker; environment: EnvironmentState } = $props();
  const pending = $derived(!worker.report || worker.report.revision !== worker.desiredRevision);
</script>

<div class="grid min-w-0 gap-5 pt-3">
  <section aria-label="Instruction files" class="grid min-w-0 gap-4">
    <h3 class="text-base font-semibold text-balance">Instruction files</h3>
    {#if pending}<Alert>Waiting for the latest instruction report.</Alert>{/if}
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
              onresolve={(action) => environment.resolve(worker.workerId, file, action)}
            />
          </Disclosure>
        {:else if file.status === "error"}<Alert tone="error">{file.detail}</Alert>{/if}
      </div>
    {:else}{#if !pending}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          No instruction files in the latest report.
        </p>{/if}{/each}
  </section>
  <InstructionPreview {worker} draft={environment.draft} />
</div>
