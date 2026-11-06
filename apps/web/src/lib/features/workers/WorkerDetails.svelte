<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import WorkerAccounts from "./WorkerAccounts.svelte";
  import WorkerCliTools from "./WorkerCliTools.svelte";
  import WorkerConfiguration from "./WorkerConfiguration.svelte";
  import WorkerTagEditor from "./WorkerTagEditor.svelte";
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  /**
   * Everything about one worker below its name and status, as flat sections split by hairlines: agent CLIs,
   * configuration, provider accounts and tags. Settings → Workers shows it in an expanded worker, the worker page on its own.
   */
  let {
    worker,
    environment,
    linked,
    onchanged,
    reason = false,
    class: className,
  }: {
    worker: ui.Worker;
    environment: EnvironmentState;
    linked?: LinkedWorker | undefined;
    onchanged?: (() => void) | undefined;
    /** Title a read-only worker's note with the reason; in a computer's group the group says it instead. */
    reason?: boolean;
    class?: ClassValue;
  } = $props();

  const readOnly = $derived(linked?.readOnly ?? "");
</script>

<div class={["divide-y divide-zinc-950/5 dark:divide-white/8", className]}>
  {#if readOnly}<div class="px-4 py-4 sm:px-5">
      <Alert title={reason ? readOnly : undefined}>These are the last saved settings.</Alert>
    </div>{/if}
  <WorkerCliTools {worker} {readOnly} />
  <WorkerConfiguration {worker} />
  <WorkerAccounts {worker} online={worker.online && !readOnly} />
  {#key worker.id}<WorkerTagEditor {worker} {environment} {linked} {onchanged} />{/key}
</div>
