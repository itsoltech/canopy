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
      "/skills/resolve",
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

<section class={["grid min-w-0 gap-4", className]} aria-label="Skills on this computer">
  <h3 class="text-base font-semibold text-balance">Skills on this computer</h3>
  {#if !worker.skillsSupported}<Alert tone="warning"
      >Update this worker to sync skills. Its instruction support is unchanged.</Alert
    >
  {:else if pending}<Alert>Waiting for this computer to report the saved skills.</Alert>{/if}
  {#each worker.report?.skills ?? [] as file (file.targetId)}
    {@const skill = environment.snapshot.skills.find((s) => s.id === file.skillId)}
    <div class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
      <div class="flex flex-wrap items-center gap-2 text-base sm:text-sm">
        <p class="min-w-0 flex-1 font-medium break-words">
          {skill?.name ?? "Removed skill"} · {file.harness} · v{file.version.toString()}
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
      <p class="font-mono text-base break-all sm:text-sm">{file.path}</p>
      {#if file.status === "drift" || file.status === "kept"}
        <Disclosure open={file.status === "drift"}>
          {#snippet summary()}<p class="text-base sm:text-sm">Compare skill versions</p>{/snippet}
          <SkillDiff
            class="pt-4"
            {file}
            expected={file.desiredFiles}
            busy={environment.busy || !worker.online || pending}
            onresolve={(action) => resolve(file, action)}
          />
        </Disclosure>
      {:else if file.status === "error"}<Alert tone="error">{file.detail}</Alert>{/if}
    </div>
  {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      {worker.skillIds.length
        ? "Assigned skills will appear after the first sync."
        : "No skills assigned to this computer."}
    </p>{/each}
</section>
