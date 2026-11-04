<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentFileStatus } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import VersionComparison from "./VersionComparison.svelte";

  let {
    file,
    expected,
    busy,
    onresolve,
    class: className,
  }: {
    file: EnvironmentFileStatus;
    expected: string;
    busy: boolean;
    onresolve: (action: string) => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["@container grid gap-4", className]}>
  <Alert tone="warning" title={file.status === "kept" ? "Kept locally" : "Local changes need your decision"}
    >{file.detail}</Alert
  >
  <VersionComparison local={file.managedContent} {expected} />
  <div class="flex flex-wrap gap-2">
    <Button size="sm" disabled={busy} onclick={() => onresolve("keep")}>Keep mine</Button>
    <Button size="sm" disabled={busy} onclick={() => onresolve("overwrite")}>Overwrite</Button>
    <Button size="sm" disabled={busy || !file.importable} onclick={() => onresolve("import")}
      >Import into library</Button
    >
  </div>
  {#if file.importable}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      Import replaces this computer's instructions for this agent. Other computers keep their current assignments.
    </p>{/if}
</div>
