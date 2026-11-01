/** Shared look of `Button` and `ButtonLink`: one primary per view, everything else secondary or ghost. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

const base =
  "relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap focus-ring disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white not-disabled:hover:bg-blue-500",
  secondary:
    "bg-white text-zinc-950 shadow-xs ring-1 ring-zinc-950/10 not-disabled:hover:bg-zinc-50 dark:bg-white/5 dark:text-white dark:shadow-none dark:ring-white/10 dark:not-disabled:hover:bg-white/10",
  ghost: "text-zinc-700 not-disabled:hover:bg-zinc-950/5 not-disabled:hover:text-zinc-950 dark:text-zinc-300 dark:not-disabled:hover:bg-white/10 dark:not-disabled:hover:text-white",
  danger:
    "bg-white text-rose-700 shadow-xs ring-1 ring-zinc-950/10 not-disabled:hover:bg-rose-50 dark:bg-white/5 dark:text-rose-400 dark:shadow-none dark:ring-white/10 dark:not-disabled:hover:bg-rose-500/10",
};

// md: 40px on touch screens, 36px from `sm`; sm: 32px / 28px.
const sizes: Record<ButtonSize, { text: string; plain: string; icon: string }> = {
  md: { text: "gap-1.5 rounded-lg text-base/6 sm:text-sm/6", plain: "px-3 py-2 sm:py-1.5", icon: "py-2 pr-3 pl-2.5 sm:py-1.5" },
  sm: { text: "gap-1 rounded-md text-sm/5 sm:text-[0.8125rem]/5", plain: "px-2.5 py-1.5 sm:py-1", icon: "py-1.5 pr-2.5 pl-2 sm:py-1" },
};

export function buttonClasses(variant: ButtonVariant, size: ButtonSize, withIcon: boolean): string {
  const s = sizes[size];
  return `${base} ${variants[variant]} ${s.text} ${withIcon ? s.icon : s.plain}`;
}

/** Square icon-only button (the 48px touch target is added by the component). */
export function iconButtonClasses(variant: ButtonVariant, size: ButtonSize): string {
  return `${base} ${variants[variant]} ${size === "md" ? "rounded-lg p-2.5 sm:p-2" : "rounded-md p-2 sm:p-1.5"}`;
}
