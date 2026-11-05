/** Shared look of `Button` and `ButtonLink`: one primary per view, everything else secondary or ghost. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

import type { Density } from "./density.ts";

export type ButtonSize = "md" | "sm";

/** Size of a button without an explicit `size` (docs/ui-scale.md): overlays use the compact one. */
export const defaultButtonSize = (density: Density): ButtonSize => (density === "overlay" ? "sm" : "md");

const base =
  "ui-button relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap focus-ring disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-action text-on-accent not-disabled:hover:bg-action-hover not-disabled:active:bg-action-hover",
  secondary:
    "bg-white text-zinc-950 shadow-xs ring-1 ring-zinc-950/10 not-disabled:hover:bg-zinc-50 dark:bg-white/5 dark:text-white dark:shadow-none dark:ring-white/10 dark:not-disabled:hover:bg-white/10",
  ghost:
    "text-zinc-700 not-disabled:hover:bg-zinc-950/5 not-disabled:hover:text-zinc-950 dark:text-zinc-300 dark:not-disabled:hover:bg-white/10 dark:not-disabled:hover:text-white",
  danger:
    "bg-white text-rose-700 shadow-xs ring-1 ring-zinc-950/10 not-disabled:hover:bg-rose-50 dark:bg-white/5 dark:text-rose-400 dark:shadow-none dark:ring-white/10 dark:not-disabled:hover:bg-rose-500/10",
};

// md: 40px on touch screens, 36px from `sm`; sm: 32px / 28px. In an overlay, text is a step smaller (scale.css)
// and icons 14px from `sm` (Icon), so `sm` there is 32px / 28px with 13px text.
const sizes: Record<ButtonSize, { text: string; plain: string; icon: string }> = {
  md: {
    text: "gap-1.5 rounded-lg text-base/6 sm:text-sm/6",
    plain: "px-3 py-2 sm:py-1.5",
    icon: "py-2 pr-3 pl-2.5 sm:py-1.5",
  },
  sm: {
    text: "gap-1 rounded-md text-sm/5 sm:text-(length:--type-compact)/5",
    plain: "px-2.5 py-1.5 sm:py-1",
    icon: "py-1.5 pr-2.5 pl-2 sm:py-1",
  },
};

export function buttonClasses(variant: ButtonVariant, size: ButtonSize, withIcon: boolean): string {
  const s = sizes[size];

  return `${base} ${variants[variant]} ${s.text} ${withIcon ? s.icon : s.plain}`;
}

/** Square icon-only button (the 48px touch target is added by the component). */
// An icon alone reads heavier than a word in the same colour: ghost icon buttons rest a step lighter and
// take the full colour on hover.
const ghostIcon =
  "text-icon-muted not-disabled:hover:bg-zinc-950/5 not-disabled:hover:text-icon-emphasis not-disabled:focus-visible:text-icon-emphasis aria-expanded:text-icon-emphasis aria-pressed:text-icon-emphasis dark:not-disabled:hover:bg-white/10";

// In an overlay the icon is 14px from `sm`: 7px padding keeps `sm` at 28px, level with text buttons and rows.
const iconPadding = {
  md: "rounded-lg p-2.5 sm:p-2",
  sm: "rounded-md p-2 sm:p-1.5",
  overlay: "rounded-md p-2 sm:p-[0.4375rem]",
} as const;

export function iconButtonClasses(variant: ButtonVariant, size: ButtonSize, density: Density = "standard"): string {
  const padding = size === "sm" && density === "overlay" ? iconPadding.overlay : iconPadding[size];

  return `${base} ${variant === "ghost" ? ghostIcon : variants[variant]} ${padding}`;
}
