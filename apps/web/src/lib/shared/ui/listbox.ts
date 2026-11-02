/**
 * Looks shared by listboxes whose options are driven from a text field (Combobox, the composer's mention popup):
 * a sticky group heading and an option row that highlights the active option (`data-active`).
 */
export const listboxHeadingClasses =
  "sticky top-0 z-10 bg-white pt-2 pb-1 text-sm/5 font-medium text-zinc-500 sm:text-xs/4 dark:bg-zinc-900 dark:text-zinc-400";

export const listboxOptionClasses =
  "cursor-default scroll-mt-9 rounded-lg px-2.5 py-2 text-base/6 text-zinc-800 select-none data-active:bg-zinc-950/5 data-active:text-zinc-950 sm:py-1.5 sm:text-sm/5 dark:text-zinc-200 dark:data-active:bg-white/8 dark:data-active:text-white";
