<script lang="ts">
  import { untrack } from "svelte";
  import type { BrowserSessionDefaults } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";

  let { value = $bindable() }: { value: BrowserSessionDefaults } = $props();
  let custom = $state(false);

  const presets = [
    { value: "", label: "Browser default" },
    { value: "1280x720", label: "1280 × 720" },
    { value: "1440x900", label: "1440 × 900" },
    { value: "1920x1080", label: "1920 × 1080" },
    { value: "390x844", label: "390 × 844" },
    { value: "custom", label: "Custom size" },
  ];

  const size = $derived(
    value.viewportWidth != null || value.viewportHeight != null ? `${value.viewportWidth}x${value.viewportHeight}` : "",
  );

  $effect(() => {
    const current = value;
    untrack(() => {
      const key =
        current.viewportWidth != null || current.viewportHeight != null
          ? `${current.viewportWidth}x${current.viewportHeight}`
          : "";

      custom = !presets.some((item) => item.value === key);
    });
  });

  const preset = $derived(custom || !presets.some((item) => item.value === size) ? "custom" : size);

  function resize(next: string) {
    custom = next === "custom";

    if (custom) return;
    const [width, height] = next.split("x").map(Number);
    value.viewportWidth = width || undefined;
    value.viewportHeight = height || undefined;
  }
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <Field label="Viewport size" description="The page area when a new browser session starts.">
    <Select value={preset} options={presets} onchange={resize} />
  </Field>
  <Field label="Page appearance" description="The color scheme requested from websites.">
    <Select
      bind:value={value.colorScheme}
      options={[
        { value: "", label: "Browser default" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "no-preference", label: "No preference" },
      ]}
    />
  </Field>
</div>
{#if preset === "custom"}
  <div class="grid grid-cols-2 gap-3">
    <Field label="Width (px)"
      ><Input
        type="number"
        steppers={false}
        min={320}
        max={8192}
        step={1}
        required
        bind:value={value.viewportWidth}
      /></Field
    >
    <Field label="Height (px)"
      ><Input
        type="number"
        steppers={false}
        min={320}
        max={8192}
        step={1}
        required
        bind:value={value.viewportHeight}
      /></Field
    >
  </div>
{/if}
