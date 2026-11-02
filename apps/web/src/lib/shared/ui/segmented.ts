/**
 * Look of a segmented control (T3 style): a recessed track with equal segments, the active one
 * raised. Segments mark themselves active with `data-active`, whether they are links or buttons.
 * With a sliding pill (`segmentedPill`, motion.css `t-tabs-pill`) the segments are `segmentedLabel`:
 * the pill is the raised surface and travels between them.
 */
export const segmentedTrack = "gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5";

export const segmentedLabel =
  "relative flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm/5 font-medium text-zinc-500 hover:text-zinc-950 focus-ring data-active:text-zinc-950 sm:py-1 sm:text-[0.8125rem]/5 dark:text-zinc-400 dark:hover:text-white dark:data-active:text-white";

export const segmentedItem = `${segmentedLabel} data-active:bg-white data-active:shadow-xs data-active:ring-1 data-active:ring-zinc-950/5 dark:data-active:bg-white/10 dark:data-active:shadow-none dark:data-active:ring-0`;

/** The raised pill alone, one segment wide, placed in a `relative` track. */
export const segmentedPill =
  "pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-white shadow-xs ring-1 ring-zinc-950/5 dark:bg-white/10 dark:shadow-none dark:ring-0";
