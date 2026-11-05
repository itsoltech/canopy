<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { normalizeColor } from "../mascot.ts";
  import { hexToHsv, hsvToHex } from "./color.ts";
  import ColorChannel from "./ColorChannel.svelte";

  let {
    value = $bindable("#f97316"),
    disabled = false,
    class: className,
  }: { value?: string; disabled?: boolean; class?: ClassValue } = $props();

  let hsv = $state({ hue: 24, saturation: 91, value: 98 });

  $effect(() => {
    const valid = normalizeColor(value);

    if (valid && valid !== untrack(() => hsvToHex(hsv.hue, hsv.saturation, hsv.value))) hsv = hexToHsv(valid);
  });

  function set(channel: "hue" | "saturation" | "value", next: number) {
    hsv = { ...hsv, [channel]: next };
    value = hsvToHex(hsv.hue, hsv.saturation, hsv.value);
  }
</script>

<div class={["grid gap-2 rounded-xl bg-zinc-950/3 p-3 dark:bg-white/5", className]}>
  <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
    <ColorChannel
      label="Hue"
      value={hsv.hue}
      max={360}
      gradient="linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
      onchange={(v) => set("hue", v)}
      {disabled}
    />
    <ColorChannel
      label="Saturation"
      value={hsv.saturation}
      gradient={`linear-gradient(to right, ${hsvToHex(hsv.hue, 0, hsv.value)}, ${hsvToHex(hsv.hue, 100, hsv.value)})`}
      onchange={(v) => set("saturation", v)}
      {disabled}
    />
    <ColorChannel
      label="Brightness"
      value={hsv.value}
      gradient={`linear-gradient(to right, #000, ${hsvToHex(hsv.hue, hsv.saturation, 100)})`}
      onchange={(v) => set("value", v)}
      {disabled}
    />
    <Field label="Hex color" error={!normalizeColor(value) ? "Use #RGB or #RRGGBB." : undefined}>
      <Input bind:value {disabled} aria-label="Hex color" spellcheck="false" autocomplete="off" placeholder="#a3e635" />
    </Field>
  </div>
</div>
