<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentSkillStatus, SkillFile } from "@canopy/contracts";
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
    onresolve: (action: string) => void;
    plugin?: boolean;
    class?: ClassValue;
  } = $props();

  let path = $state("SKILL.md");
  const paths = $derived([...new Set([...expected, ...file.managedFiles].map((f) => f.path))].sort());

  $effect(() => {
    if (!paths.includes(path)) path = paths[0] ?? "";
  });

  function text(files: readonly SkillFile[]): string {
    const selected = files.find((f) => f.path === path);

    if (!selected) return "(File absent)";

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(selected.content);
    } catch {
      return `(Binary file · ${selected.content.length} bytes · SHA-256 ${selected.checksum})`;
    }
  }
</script>

<div class={["@container grid min-w-0 gap-4", className]}>
  <Alert tone="warning">{file.detail}</Alert>
  {#if paths.length}
    <Field label={plugin ? "Compare plugin file" : "Compare skill file"}
      ><Select
        name="skill-diff-path"
        bind:value={path}
        options={paths.map((value) => ({ value, label: value }))}
      /></Field
    >
    <VersionComparison local={text(file.managedFiles)} expected={text(expected)} />
  {/if}
  <div class="flex flex-wrap gap-2">
    <Button size="sm" disabled={busy} onclick={() => onresolve("keep")}>Keep mine</Button>
    <Button size="sm" disabled={busy || !file.owned} onclick={() => onresolve("overwrite")}>Overwrite</Button>
    {#if !plugin}<Button size="sm" disabled={busy || !file.importable} onclick={() => onresolve("import")}
        >Import into library</Button
      >{/if}
  </div>
  {#if !plugin}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      Import creates a version pinned to this computer. Other computers keep their selected version. Additional
      user-owned files remain private.
    </p>{/if}
</div>
