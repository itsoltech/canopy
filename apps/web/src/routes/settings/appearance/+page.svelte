<script lang="ts">
  import { theme, type ThemeChoice } from "#lib/shared/theme.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  const options: { value: ThemeChoice; label: string; description: string; icon: IconName }[] = [
    { value: "system", label: "System", description: "Follow the operating system.", icon: "computer-desktop" },
    { value: "dark", label: "Dark", description: "Black canvas, easy on the eyes.", icon: "moon" },
    { value: "light", label: "Light", description: "White canvas.", icon: "sun" },
  ];
</script>

<svelte:head><title>Appearance · Settings · Open Agents</title></svelte:head>

<SettingsGroup title="Theme" description="Stored in this browser.">
  <fieldset>
    <legend class="sr-only">Theme</legend>
    {#each options as option (option.value)}
      <label class="flex cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-zinc-950/2.5 has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-blue-500 not-last:border-b not-last:border-zinc-950/5 dark:hover:bg-white/2.5 dark:not-last:border-white/8">
        <Icon name={option.icon} class="fill-zinc-400 dark:fill-zinc-500" />
        <span class="min-w-0 flex-1">
          <span class="block text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{option.label}</span>
          <span class="block text-sm/5 text-zinc-500 dark:text-zinc-400">{option.description}</span>
        </span>
        <span class="group inline-grid size-5 grid-cols-1 sm:size-4">
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme.choice === option.value}
            onchange={() => theme.set(option.value)}
            class="col-start-1 row-start-1 appearance-none rounded-full border border-zinc-300 bg-white checked:border-blue-600 checked:bg-blue-600 focus-visible:outline-none dark:border-white/15 dark:bg-white/5 dark:checked:border-blue-500 dark:checked:bg-blue-500 forced-colors:appearance-auto"
          />
          <span class="pointer-events-none col-start-1 row-start-1 size-[round(down,40%,1px)] self-center justify-self-center rounded-full bg-white group-not-has-checked:opacity-0"></span>
        </span>
      </label>
    {/each}
  </fieldset>
</SettingsGroup>
