<script lang="ts">
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

  let { text, raw, display }: { text: string; raw: string; display: boolean } = $props();
  let target = $state<HTMLSpanElement>();

  $effect(() => {
    if (!target) return;
    const element = target;
    element.textContent = raw;

    if (devicePreferences.values.renderMath === "off") return;
    let active = true;
    void import("katex")
      .then(({ default: katex }) => {
        if (active)
          katex.render(text, element, {
            displayMode: display,
            throwOnError: false,
            trust: false,
            strict: "error",
            maxExpand: 200,
            maxSize: 20,
            output: "htmlAndMathml",
          });
      })
      .catch(() => {
        if (active) element.textContent = raw;
      });

    return () => {
      active = false;
    };
  });
</script>

<span bind:this={target} class={display ? "block max-w-full overflow-x-auto py-2" : undefined}>{raw}</span>
