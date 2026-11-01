<script lang="ts">
  import { page } from "$app/state";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";

  /** Settings sections; a column on wide screens, a scrolling row on narrow ones. */
  const sections: { href: string; label: string; icon: IconName; group: string }[] = [
    { href: "/settings/projects", label: "Projects", icon: "folder", group: "Code" },
    { href: "/settings/workers", label: "Workers", icon: "server", group: "Connections" },
    { href: "/settings/appearance", label: "Appearance", icon: "swatch", group: "General" },
  ];
  const groups = ["General", "Code", "Connections"];
  const active = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  const itemClass =
    "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-base/6 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:py-1.5 sm:text-sm/6 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/8 dark:aria-[current=page]:text-white";
</script>

<nav aria-label="Settings">
  <ul role="list" class="flex gap-1 overflow-x-auto lg:hidden">
    {#each sections as section (section.href)}
      <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} />{section.label}</a></li>
    {/each}
  </ul>
  <div class="grid gap-5 max-lg:hidden">
    {#each groups as group (group)}
      <div>
        <h2 class="px-2.5 text-sm/6 text-zinc-500 sm:text-xs/6 dark:text-zinc-500">{group}</h2>
        <ul role="list" class="mt-1 grid gap-0.5">
          {#each sections.filter((s) => s.group === group) as section (section.href)}
            <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} class="fill-current" />{section.label}</a></li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
</nav>
