<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentSkillStatus, SkillFile } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import VersionComparison from "./VersionComparison.svelte";

  let {
    file,
    expected,
    busy,
    onresolve,
    plugin = false,
    class: className,
  }: {
    file: EnvironmentSkillStatus;
    expected: readonly SkillFile[];
    busy: boolean;
    onresolve?: ((action: "keep" | "overwrite" | "import") => void) | undefined;
    plugin?: boolean;
    class?: ClassValue;
  } = $props();

  let path = $state("SKILL.md");
  const paths = $derived([...new Set([...expected, ...file.managedFiles].map((f) => f.path))].sort());

  $effect(() => {
    if (!paths.includes(path)) path = paths[0] ?? "";
  });

  function text(files: readonly SkillFile[], absent = "(File absent)"): string {
    const selected = files.find((f) => f.path === path);

    if (!selected) return absent;

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(selected.content);
    } catch {
      return `(Binary file · ${selected.content.length} bytes · SHA-256 ${selected.checksum})`;
    }
  }
</script>

{#snippet comparison()}
  <Field label={plugin ? "Compare plugin file" : "Compare skill file"}>
    <Select name="skill-diff-path" bind:value={path} options={paths.map((value) => ({ value, label: value }))} />
  </Field>
  <VersionComparison
    local={text(file.managedFiles, plugin ? "(File absent)" : "(No managed file at this path)")}
    localLabel={plugin ? "On this computer" : "Managed file on this computer"}
    expected={text(expected)}
  />
{/snippet}

<div class={["@container grid min-w-0 gap-3", className]}>
  {#if plugin}
    <Alert tone="warning">{file.detail}</Alert>
    {#if paths.length}{@render comparison()}{/if}
    <div class="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onclick={() => onresolve?.("keep")}>Keep mine</Button>
      <Button size="sm" disabled={busy || !file.owned} onclick={() => onresolve?.("overwrite")}>Overwrite</Button>
    </div>
  {:else}
    {#if file.owned && paths.length}
      <Disclosure>
        {#snippet summary()}Compare managed files{/snippet}
        <div class="grid min-w-0 gap-3 pt-3">{@render comparison()}</div>
      </Disclosure>
    {/if}
    {#if onresolve}
      <div class="flex flex-wrap gap-2">
        {#if file.status !== "kept"}
          <Button size="sm" disabled={busy} onclick={() => onresolve?.("keep")}>Keep local copy</Button>
        {/if}
        {#if file.owned}
          <Button size="sm" disabled={busy} onclick={() => onresolve?.("overwrite")}>
            {file.desiredChecksum ? "Use library version" : "Remove managed files"}
          </Button>
        {/if}
        {#if file.owned && file.importable}
          <Button size="sm" disabled={busy} onclick={() => onresolve?.("import")}>Save local version</Button>
        {/if}
      </div>
      {#if file.owned && file.importable}
        <p class="text-sm text-muted">Saving creates a library version pinned to this computer.</p>
      {/if}
    {/if}
  {/if}
</div>
