/**
 * The look of palette-style dialogs (the command palette, Add project): a panel near the top from `sm`, a
 * full-width sheet at the top on phones (the keyboard covers the bottom), a search row, options and a key legend.
 */
export const paletteDialogClass =
  "t-modal top-(--window-safe-top) m-0 mb-auto flex max-h-[min(85dvh,var(--window-safe-height))] w-full max-w-none flex-col overflow-hidden rounded-b-2xl bg-white p-0 text-zinc-950 shadow-xl ring-1 ring-zinc-950/10 not-open:hidden backdrop:bg-zinc-950/30 backdrop:backdrop-blur-xs sm:mx-auto sm:mt-[12dvh] sm:max-h-[min(36rem,76dvh,var(--window-safe-height)-12dvh)] sm:w-[calc(100%-2rem)] sm:max-w-160 sm:rounded-2xl dark:bg-zinc-900 dark:text-white dark:shadow-none dark:ring-white/10 dark:backdrop:bg-black/50";

export const paletteHeaderClass =
  "flex shrink-0 items-center gap-2 border-b border-zinc-950/5 px-3 pt-[max(--spacing(0),env(safe-area-inset-top))] dark:border-white/8";

export const paletteInputClass =
  "h-12 min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:h-11 sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400";

export const paletteListClass =
  "scroll-stable min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 pb-[max(--spacing(1.5),env(safe-area-inset-bottom))] sm:pb-1.5";

export const paletteGroupLabelClass =
  "px-2.5 pt-2.5 pb-0.5 text-sm/5 font-medium text-zinc-500 first:pt-1 sm:text-xs/4 dark:text-zinc-400";

export const paletteRowClass =
  "group/row flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-base/6 text-zinc-800 select-none scroll-my-1 data-active:bg-zinc-950/5 data-active:text-zinc-950 aria-disabled:text-zinc-400 sm:py-1.5 sm:text-sm/5 dark:text-zinc-200 dark:data-active:bg-white/8 dark:data-active:text-white dark:aria-disabled:text-zinc-600";

export const paletteRowIconClass =
  "fill-zinc-500 group-aria-disabled/row:fill-zinc-300 group-data-active/row:fill-zinc-700 dark:fill-zinc-400 dark:group-aria-disabled/row:fill-zinc-700 dark:group-data-active/row:fill-zinc-200";

export const paletteEmptyClass = "px-4 py-10 text-center text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400";

export const paletteFooterClass =
  "flex shrink-0 items-center gap-4 border-t border-zinc-950/5 px-3 py-2 text-xs/4 text-zinc-500 dark:border-white/8 dark:text-zinc-400 pointer-coarse:hidden";
