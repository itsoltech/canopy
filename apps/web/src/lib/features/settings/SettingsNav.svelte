<script lang="ts">
  import { page } from "$app/state";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { settingsGroups, settingsSections } from "./sections.ts";

  /** Settings sections with a search filter (T3 style); a scrolling row on narrow screens. */
  let query = $state("");
  const visible = $derived(
    settingsSections.filter((s) => !query.trim() || `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const active = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  const itemClass =
    "flex shrink-0 items-center gap-2.5 rounded-lg whitespace-nowrap px-2.5 py-2 text-base/6 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:py-1.5 sm:text-sm/6 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/8 dark:aria-[current=page]:text-white";
</script>

<nav aria-label="Settings" class="grid grid-cols-1 gap-3">
  <label class="flex items-center gap-2 rounded-lg px-2.5 py-2 ring-1 ring-zinc-950/10 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 max-lg:hidden sm:py-1.5 dark:ring-white/10">
    <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
    <span class="sr-only">Search settings</span>
    <input
      type="search"
      name="settings-search"
      data-autofocus
      bind:value={query}
      placeholder="Search"
      autocomplete="off"
      class="min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
    />
  </label>

  <ul role="list" class="flex gap-1 overflow-x-auto lg:hidden">
    {#each settingsSections as section (section.href)}
      <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} class="fill-current" />{section.label}</a></li>
    {/each}
  </ul>

  <div class="grid grid-cols-1 gap-5 max-lg:hidden">
    {#each settingsGroups as group (group)}
      {@const items = visible.filter((s) => s.group === group)}
      {#if items.length > 0}
        <div>
          <h2 class="px-2.5 text-sm/6 text-zinc-500 sm:text-xs/6">{group}</h2>
          <ul role="list" class="mt-1 grid gap-0.5">
            {#each items as section (section.href)}
              <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} class="fill-current" />{section.label}</a></li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else}
      <p class="px-2.5 text-sm/6 text-zinc-500">No setting matches “{query}”.</p>
    {/each}
  </div>
</nav>
