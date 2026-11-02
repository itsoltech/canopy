<script lang="ts">
  import {
    accentLabels,
    accentNames,
    accentOf,
    chatWidthLabels,
    chatWidthNames,
    chatWidthOf,
    schemeLabels,
    schemeNames,
    schemeOf,
    type AccentName,
    type ChatWidthName,
    type SchemeName,
  } from "#lib/features/settings/appearance.ts";
  import SchemePreview from "#lib/features/settings/SchemePreview.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import AnimatedMascotsSetting from "#lib/features/bots/components/AnimatedMascotsSetting.svelte";

  /** Saved in the gateway: the same on every device, changes elsewhere show up here live. */
  const settings = useSettings();
  const scheme = $derived(schemeOf(settings.appearance));
  const accent = $derived(accentOf(settings.appearance));
  const chatWidth = $derived(chatWidthOf(settings.appearance));

  const schemes = (["system", "light", "dark"] as const).map((value: SchemeName) => ({ value, label: schemeLabels[value] }));
  // Each theme: its accent, shown as a light and a dark orb.
  const accents: { value: AccentName; label: string; light: string; dark: string }[] = [
    { value: "default", label: accentLabels.default, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-blue-100)_45%,var(--color-blue-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-blue-400),var(--color-zinc-900)_60%,black)]" },
    { value: "grove", label: accentLabels.grove, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-emerald-100)_45%,var(--color-emerald-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-emerald-400),var(--color-emerald-900)_60%,black)]" },
    { value: "ocean", label: accentLabels.ocean, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-sky-100)_45%,var(--color-sky-400))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-sky-400),var(--color-sky-900)_60%,black)]" },
    { value: "ember", label: accentLabels.ember, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-orange-100)_45%,var(--color-orange-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-orange-400),var(--color-orange-900)_60%,black)]" },
    { value: "iris", label: accentLabels.iris, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-violet-100)_45%,var(--color-violet-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-violet-400),var(--color-violet-900)_60%,black)]" },
    { value: "rose", label: accentLabels.rose, light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-pink-100)_45%,var(--color-pink-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-pink-400),var(--color-pink-900)_60%,black)]" },
  ];
  const cardClass =
    "group relative grid cursor-pointer gap-2 rounded-2xl p-2 ring-1 ring-zinc-950/10 hover:ring-zinc-950/20 has-checked:ring-2 has-checked:ring-brand-500 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-500 dark:ring-white/10 dark:hover:ring-white/20 dark:has-checked:ring-brand-500";
</script>

<svelte:head><title>Appearance · Settings · Open Agents</title></svelte:head>

<section aria-labelledby="scheme-title">
  <h2 id="scheme-title" class="mb-3 px-1 text-base/7 font-semibold">Color scheme</h2>
  <div class="@container">
    <div class="grid grid-cols-3 gap-2 @md:gap-3" role="radiogroup" aria-labelledby="scheme-title">
      {#each schemes as option (option.value)}
        <label class={cardClass}>
          <input type="radio" name="scheme" value={option.value} class="sr-only" checked={scheme === option.value} onchange={() => settings.updateAppearance({ colorScheme: schemeNames[option.value] })} />
          <div class="relative aspect-[16/9] overflow-hidden rounded-[calc(var(--radius-2xl)-var(--spacing)*2)] ring-1 ring-zinc-950/5 dark:ring-white/5">
            {#if option.value === "system"}
              <SchemePreview mode="light" class="absolute inset-0" />
              <SchemePreview mode="dark" class="absolute inset-0 [clip-path:inset(0_0_0_50%)]" />
            {:else}
              <SchemePreview mode={option.value} />
            {/if}
          </div>
          <span class="pb-1 text-center text-sm/6 text-zinc-600 group-has-checked:font-medium group-has-checked:text-zinc-950 dark:text-zinc-400 dark:group-has-checked:text-white">{option.label}</span>
        </label>
      {/each}
    </div>
  </div>
</section>

<section aria-labelledby="themes-title">
  <h2 id="themes-title" class="mb-1 px-1 text-base/7 font-semibold">Themes</h2>
  <p class="mb-3 px-1 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The accent of buttons, focus rings and the send button.</p>
  <div class="@container">
    <div class="grid grid-cols-2 gap-3 @lg:grid-cols-3" role="radiogroup" aria-labelledby="themes-title">
      {#each accents as option (option.value)}
        <label class={[cardClass, "p-4"]}>
          <input type="radio" name="accent" value={option.value} class="sr-only" checked={accent === option.value} onchange={() => settings.updateAppearance({ accent: accentNames[option.value] })} />
          <span class="flex justify-center gap-3 py-2" aria-hidden="true">
            <span class={["size-12 rounded-full shadow-inner ring-1 ring-zinc-950/10 dark:ring-white/10", option.light]}></span>
            <span class={["size-12 rounded-full shadow-inner ring-1 ring-zinc-950/10 dark:ring-white/10", option.dark]}></span>
          </span>
          <span class="text-base/6 font-medium sm:text-sm/6">{option.label}</span>
        </label>
      {/each}
    </div>
  </div>
</section>

<SettingsGroup title="Interface">
  <AnimatedMascotsSetting />
  <SettingsRow title="Chat width" description="How wide the conversation and the message box are.">
    {#snippet control()}
      <Select
        name="chatWidth"
        aria-label="Chat width"
        value={chatWidth}
        onchange={(value) => settings.updateAppearance({ chatWidth: chatWidthNames[value as ChatWidthName] })}
        class="w-40"
        options={Object.entries(chatWidthLabels).map(([value, label]) => ({ value, label }))}
      />
    {/snippet}
  </SettingsRow>
</SettingsGroup>
