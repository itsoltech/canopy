<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { SkillFileSchema, type SkillFile } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    onupload,
    onready,
    class: className,
  }: {
    onupload: (files: SkillFile[], zip: Uint8Array) => void;
    onready: (ready: boolean) => void;
    class?: ClassValue;
  } = $props();

  let folder: HTMLInputElement | undefined;
  let archive: HTMLInputElement | undefined;
  let summary = $state("");
  let error = $state("");
  let reading = $state(false);

  async function read(input: HTMLInputElement, zip: boolean) {
    const files = [...(input.files ?? [])];

    if (!files.length) return;
    error = "";
    reading = true;
    onready(false);
    onupload([], new Uint8Array());

    try {
      const size = files.reduce((sum, f) => sum + f.size, 0);

      if (
        files.length > 1000 ||
        size > (zip ? 10 : 25) * 1024 * 1024 ||
        (!zip && files.some((f) => f.size > 1024 * 1024))
      )
        throw new Error("Use at most 1000 files, 1 MiB per file, 25 MiB total, or a ZIP up to 10 MiB.");

      if (zip) onupload([], new Uint8Array(await files[0]!.arrayBuffer()));
      else {
        const uploaded = await Promise.all(
          files.map(async (file) =>
            create(SkillFileSchema, {
              path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name,
              content: new Uint8Array(await file.arrayBuffer()),
            }),
          ),
        );

        onupload(uploaded, new Uint8Array());
      }

      summary = `${zip ? files[0]!.name : `${files.length} files`} · ${(size / 1024).toFixed(1)} KiB ready to upload`;
      onready(true);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Couldn't read this skill.";
    } finally {
      reading = false;
      input.value = "";
    }
  }
</script>

<div class={["grid min-w-0 gap-3 rounded-lg bg-zinc-950/3 p-4 dark:bg-white/4", className]}>
  <h3 class="text-base font-medium text-balance">Skill files</h3>
  <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
    Choose one folder with SKILL.md at its root, or a ZIP. Review executable scripts before saving.
  </p>
  <div class="flex flex-wrap gap-2">
    <Button disabled={reading} onclick={() => folder?.click()}>Choose folder</Button>
    <Button disabled={reading} onclick={() => archive?.click()}>Choose ZIP</Button>
  </div>
  <Input
    type="file"
    class="sr-only"
    aria-label="Skill folder"
    multiple
    webkitdirectory
    onchange={(event) => read(event.currentTarget, false)}
    {@attach (node: HTMLInputElement) => {
      folder = node;
    }}
  />
  <Input
    type="file"
    class="sr-only"
    aria-label="Skill ZIP"
    accept=".zip,application/zip"
    onchange={(event) => read(event.currentTarget, true)}
    {@attach (node: HTMLInputElement) => {
      archive = node;
    }}
  />
  {#if summary}<p class="text-base tabular-nums sm:text-sm" role="status">{summary}</p>{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
</div>
