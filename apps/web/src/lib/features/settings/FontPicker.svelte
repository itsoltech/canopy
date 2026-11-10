<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { fontPresets, fontStack, localFontFamily, validFontFamily, type FontKind } from "@canopy/ui/fonts";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import PickerTrigger from "#lib/shared/ui/PickerTrigger.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import FontOption from "./FontOption.svelte";
  import { fontInstalled, fontMonospace, installedFonts } from "./local-fonts.ts";
  import { deviceDefaults, devicePreferences as device } from "./device-preferences.svelte.ts";

  let { kind, class: className }: { kind: FontKind; class?: ClassValue } = $props();
  const preference = $derived(kind === "mono" ? "monoFont" : "interfaceFont");
  const title = $derived(kind === "mono" ? "Monospace font" : "Interface font");

  const description = $derived(
    kind === "mono"
      ? "Set the typeface for code, diffs and terminal output."
      : "Set the typeface for navigation, controls and messages.",
  );

  let families = $state<string[]>([]);
  let query = $state("");
  let open = $state(false);
  let loading = $state(false);
  let error = $state("");
  let revision = $state(0);
  const value = $derived(device.values[preference]);
  const family = $derived(localFontFamily(value));
  const presets = $derived(fontPresets(kind));
  const chosenLabel = $derived(family ?? presets.find((font) => font.value === value)?.label ?? "Choose a font");

  const items = $derived([...presets, ...families.map((name) => ({ value: `local:${name}`, label: name }))]);

  const candidate = $derived(query.trim());
  const candidateInstalled = $derived(revision >= 0 && !!candidate && fontInstalled(candidate));
  const missing = $derived(revision > 0 && !!family && !fontInstalled(family));

  onMount(() => {
    const refresh = () => revision++;
    refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  });

  async function discover() {
    loading = true;
    error = "";

    try {
      families = await installedFonts();
      revision++;

      if (!families.length) error = "No installed fonts found. Type a font family name to preview it.";
    } catch {
      error = "Font access is unavailable. Type a font family name to preview it.";
    } finally {
      loading = false;
    }
  }
</script>

<PreferenceRow
  {title}
  {description}
  changed={value !== deviceDefaults[preference]}
  onreset={() => device.reset([preference])}
  class={className}
>
  {#snippet control()}
    <div class="w-48 max-w-full">
      <SearchPicker
        {items}
        key={(font) => font.value}
        text={(font) => font.label}
        virtual
        {value}
        label={title}
        searchLabel="Search fonts or type a family name"
        placeholder="Search fonts or type a family name"
        bind:open
        bind:query
        onselect={(font) => device.set(preference, font.value)}
      >
        {#snippet trigger(props)}
          <PickerTrigger {...props} text={chosenLabel} icon="chevron-up-down" aria-label={title} class="w-full" />
        {/snippet}
        {#snippet option(font, state)}<FontOption {...font} {kind} selected={state.selected} />{/snippet}
        {#snippet empty()}<p>Type a font family name to preview it.</p>{/snippet}
        {#snippet footer()}
          <div class="grid gap-2">
            {#if validFontFamily(candidate)}
              <div class="grid gap-1" aria-live="polite">
                <p class="truncate" title={candidate} style:font-family={fontStack(`local:${candidate}`, kind)}>
                  {candidate} · Aa Bb 0123
                </p>
                <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
                  {candidateInstalled
                    ? kind === "mono"
                      ? fontMonospace(candidate)
                        ? "Monospace"
                        : "Proportional"
                      : "Installed on this device"
                    : "Not installed on this device"}
                </p>
                <Button
                  variant="secondary"
                  disabled={!candidateInstalled}
                  onclick={() => {
                    device.set(preference, `local:${candidate}`);
                    open = false;
                  }}>Use this font</Button
                >
              </div>
            {/if}
            <Button variant="ghost" disabled={loading} onclick={discover}
              >{loading ? "Loading fonts…" : "Show installed fonts"}</Button
            >
            {#if error}<p role="status" class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">{error}</p>{/if}
          </div>
        {/snippet}
      </SearchPicker>
    </div>
  {/snippet}
  <p role="status" class="min-h-5 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
    {missing ? "Not installed on this device" : ""}
  </p>
</PreferenceRow>
