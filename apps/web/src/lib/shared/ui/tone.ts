import type { Tone } from "@canopy/domain/status-look";

/** Semantic colours (see layout.css). Full class strings, so Tailwind can see them. */
export type { Tone };

export const badgeTones: Record<Tone, string> = {
  neutral: "bg-zinc-50 text-zinc-700 ring-zinc-950/10 dark:bg-white/5 dark:text-zinc-300 dark:ring-white/10",
  sky: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20",
  emerald:
    "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  rose: "bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20",
  orange:
    "bg-orange-50 text-orange-800 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/20",
  violet:
    "bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20",
};

export const dotTones: Record<Tone, string> = {
  neutral: "fill-zinc-400 dark:fill-zinc-500",
  sky: "fill-sky-500 dark:fill-sky-400",
  amber: "fill-amber-500 dark:fill-amber-400",
  emerald: "fill-emerald-500 dark:fill-emerald-400",
  rose: "fill-rose-500 dark:fill-rose-400",
  orange: "fill-orange-500 dark:fill-orange-400",
  violet: "fill-violet-500 dark:fill-violet-400",
};

export const textTones: Record<Tone, string> = {
  neutral: "text-zinc-500 dark:text-zinc-400",
  sky: "text-sky-700 dark:text-sky-400",
  amber: "text-amber-700 dark:text-amber-400",
  emerald: "text-emerald-700 dark:text-emerald-400",
  rose: "text-rose-700 dark:text-rose-400",
  orange: "text-orange-700 dark:text-orange-400",
  violet: "text-violet-700 dark:text-violet-400",
};
