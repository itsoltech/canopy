<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";

  let { current, version, disabled, pending, onsave, class: className }: {
    current: string; version: string; disabled: boolean; pending: boolean;
    onsave(channel: string): void; class?: ClassValue;
  } = $props();
  let channel = $state("");
  $effect(() => { channel = current === "latest" ? "stable" : current; });
  const suggestions = $derived.by(() => {
    const v = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    const channels = ["stable", "beta", "nightly"];
    return v ? [...channels, `v${v[1]}`, `v${v[1]}.${v[2]}`, `v${v[1]}.${v[2]}.${v[3]}`] : channels;
  });
</script>

<form class={["grid gap-1.5", className]} onsubmit={(event) => { event.preventDefault(); onsave(channel); }}>
  <Field label="Release channel" description="Stable releases, beta previews or nightly builds. Pin stable releases with vX, vX.Y or vX.Y.Z.">
    <div class="flex flex-wrap items-center gap-3">
      <div class="min-w-0 grow basis-48 sm:max-w-xs">
        <Combobox items={suggestions} key={(s) => s} text={(s) => s} label="Release channel" name="release-channel" bind:query={channel} />
      </div>
      <div class="shrink-0"><Button type="submit" size="sm" loading={pending} disabled={disabled || channel === current}>Save channel</Button></div>
    </div>
  </Field>
</form>
