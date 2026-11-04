<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentFileStatus } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InstructionText from "./InstructionText.svelte";

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
  <div class="grid min-w-0 gap-3 @xl:grid-cols-2">
    {#each [{ label: "On this computer", content: file.managedContent }, { label: "In your library", content: expected }] as version (version.label)}
      <div class="grid min-w-0 gap-2">
        <h4 class="text-base font-medium text-balance sm:text-sm">{version.label}</h4>
        <InstructionText class="max-h-64" content={version.content} />
      </div>
    {/each}
  </div>
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
