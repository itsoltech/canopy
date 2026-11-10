import "./activity.css";

/** Activity surfaces and insets stay neutral in every state; status has its own compact label. */
export const activityHeader =
  "px-2 py-2.5 text-zinc-600 hover:bg-zinc-950/2.5 hover:text-zinc-950 sm:py-1 dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-zinc-100";

export const activitySurface =
  "activity-shell min-w-0 rounded-md border-l-2 border-zinc-950/15 bg-zinc-950/2.5 dark:border-white/15 dark:bg-white/5";

/** A clear inner inset, shared by code, output and reasoning without spending a text column on phones. */
export const activityBody = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-2 pt-1 pb-2 sm:px-3";
