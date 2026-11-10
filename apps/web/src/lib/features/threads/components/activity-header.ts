import { ItemStatus } from "@canopy/contracts";

/** Fixed insets and rail in every state; only the ink and surface change. */
export const activityHeader =
  "border-l-2 px-2 py-2.5 text-zinc-600 hover:text-zinc-950 sm:py-1 dark:text-zinc-300 dark:hover:text-zinc-100";

export function activitySurface(status: ItemStatus): string {
  if (status === ItemStatus.FAILED || status === ItemStatus.DECLINED || status === ItemStatus.INTERRUPTED)
    return "border-rose-600/30 bg-rose-500/5 hover:bg-rose-500/10 dark:border-rose-400/30 dark:bg-rose-400/5 dark:hover:bg-rose-400/10";

  return "border-zinc-950/15 bg-zinc-950/2.5 hover:bg-zinc-950/5 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10";
}
