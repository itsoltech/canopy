<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui, type EnvironmentSkillStatus } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { encode } from "#lib/shared/wire.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SkillDiff from "./SkillDiff.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";

  let {
    worker,
    environment,
    class: className,
  }: { worker: ui.EnvironmentWorker; environment: EnvironmentState; class?: ClassValue } = $props();

  const pending = $derived(worker.report?.revision !== worker.desiredRevision);

  async function resolve(file: EnvironmentSkillStatus, action: string) {
    await environment.mutate(
      "POST",
      "/plugins/resolve",
      encode(
        ui.ResolveSkillDriftRequestSchema,
        create(ui.ResolveSkillDriftRequestSchema, {
          workerId: worker.workerId,
          targetId: file.targetId,
          action,
          observedChecksum: file.observedChecksum,
          expectedRevision: environment.snapshot.revision,
        }),
      ),
    );
  }
</script>

<section class={["grid min-w-0 gap-4", className]} aria-label="Plugins on this computer">
  <h3 class="text-base font-semibold text-balance">Plugins on this computer</h3>
  {#if !worker.pluginsSupported}<Alert tone="warning">Update this worker to sync plugins.</Alert>
  {:else if pending}<Alert>Waiting for this computer to report its saved plugins.</Alert>{/if}
  {#each worker.report?.plugins ?? [] as file (file.targetId)}
    {@const plugin = environment.snapshot.plugins.find((p) => p.assignment?.id === file.skillId)}
    <div class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
      <div class="flex flex-wrap items-center gap-2 text-base sm:text-sm">
        <p class="min-w-0 flex-1 font-medium wrap-anywhere">
          {file.skillId ? (plugin?.assignment?.name ?? "Removed plugin") : "Plugin activation"} · {file.harness}
        </p>
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
      <p class="font-mono text-base wrap-anywhere sm:text-sm">{file.path}</p>
      {#if file.status === "drift" || file.status === "kept"}
        <Disclosure open={file.status === "drift"}>
          {#snippet summary()}<p class="text-base sm:text-sm">Compare managed plugin files</p>{/snippet}
          <SkillDiff
            class="pt-4"
            {file}
            expected={file.desiredFiles}
            busy={environment.busy || !worker.online || pending}
            onresolve={(action) => resolve(file, action)}
            plugin
          />
        </Disclosure>
      {:else if file.status === "error"}<Alert tone="error">{file.detail}</Alert>{/if}
    </div>
  {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      {worker.pluginIds.length
        ? "Assigned plugins appear after the first sync."
        : "No plugins assigned to this computer."}
    </p>{/each}
</section>
