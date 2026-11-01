<script lang="ts">
  import SchemePreview from "#lib/features/settings/SchemePreview.svelte";
  import { preferences, type Accent, type ChatWidth, type ColorScheme } from "#lib/shared/preferences.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  const schemes: { value: ColorScheme; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  // Each theme: its accent, shown as a light and a dark orb.
  const accents: { value: Accent; label: string; light: string; dark: string }[] = [
    { value: "default", label: "Default", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-blue-100)_45%,var(--color-blue-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-blue-400),var(--color-zinc-900)_60%,black)]" },
    { value: "grove", label: "Grove", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-emerald-100)_45%,var(--color-emerald-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-emerald-400),var(--color-emerald-900)_60%,black)]" },
    { value: "ocean", label: "Ocean", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-sky-100)_45%,var(--color-sky-400))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-sky-400),var(--color-sky-900)_60%,black)]" },
    { value: "ember", label: "Ember", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-orange-100)_45%,var(--color-orange-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-orange-400),var(--color-orange-900)_60%,black)]" },
    { value: "iris", label: "Iris", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-violet-100)_45%,var(--color-violet-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-violet-400),var(--color-violet-900)_60%,black)]" },
    { value: "rose", label: "Rose", light: "bg-[radial-gradient(circle_at_35%_30%,white,var(--color-pink-100)_45%,var(--color-pink-300))]", dark: "bg-[radial-gradient(circle_at_35%_30%,var(--color-pink-400),var(--color-pink-900)_60%,black)]" },
  ];
  const cardClass =
    "group relative grid cursor-pointer gap-2 rounded-2xl p-2 ring-1 ring-zinc-950/10 hover:ring-zinc-950/20 has-checked:ring-2 has-checked:ring-brand-500 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-500 dark:ring-white/10 dark:hover:ring-white/20 dark:has-checked:ring-brand-500";
</script>

<svelte:head><title>Appearance · Settings · Open Agents</title></svelte:head>

<section aria-labelledby="scheme-title">
  <h2 id="scheme-title" class="mb-3 px-1 text-base/7 font-semibold">Color scheme</h2>
  <div class="@container">
    <div class="grid grid-cols-3 gap-2 @md:gap-3" role="radiogroup" aria-labelledby="scheme-title">
      {#each schemes as scheme (scheme.value)}
        <label class={cardClass}>
          <input type="radio" name="scheme" value={scheme.value} class="sr-only" checked={preferences.scheme === scheme.value} onchange={() => preferences.update({ scheme: scheme.value })} />
          <div class="relative aspect-[16/9] overflow-hidden rounded-[calc(var(--radius-2xl)-var(--spacing)*2)] ring-1 ring-zinc-950/5 dark:ring-white/5">
            {#if scheme.value === "system"}
              <SchemePreview mode="light" class="absolute inset-0" />
              <SchemePreview mode="dark" class="absolute inset-0 [clip-path:inset(0_0_0_50%)]" />
            {:else}
              <SchemePreview mode={scheme.value} />
            {/if}
          </div>
          <span class="pb-1 text-center text-sm/6 text-zinc-600 group-has-checked:font-medium group-has-checked:text-zinc-950 dark:text-zinc-400 dark:group-has-checked:text-white">{scheme.label}</span>
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
      {#each accents as accent (accent.value)}
        <label class={[cardClass, "p-4"]}>
          <input type="radio" name="accent" value={accent.value} class="sr-only" checked={preferences.accent === accent.value} onchange={() => preferences.update({ accent: accent.value })} />
          <span class="flex justify-center gap-3 py-2" aria-hidden="true">
            <span class={["size-12 rounded-full shadow-inner ring-1 ring-zinc-950/10 dark:ring-white/10", accent.light]}></span>
            <span class={["size-12 rounded-full shadow-inner ring-1 ring-zinc-950/10 dark:ring-white/10", accent.dark]}></span>
          </span>
          <span class="text-base/6 font-medium sm:text-sm/6">{accent.label}</span>
        </label>
      {/each}
    </div>
  </div>
</section>

<SettingsGroup title="Interface">
  <SettingsRow title="Chat width" description="How wide the conversation and the message box are.">
    {#snippet control()}
      <Select
        name="chatWidth"
        aria-label="Chat width"
        value={preferences.chatWidth}
        onchange={(event) => preferences.update({ chatWidth: (event.currentTarget as HTMLSelectElement).value as ChatWidth })}
        class="w-40"
      >
        <option value="comfortable">Comfortable</option>
        <option value="wide">Wide</option>
        <option value="full">Full width</option>
      </Select>
    {/snippet}
  </SettingsRow>
</SettingsGroup>
