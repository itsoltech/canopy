import { tick } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { duration } from "#lib/shared/ui/motion.ts";

/** Wait for the sheet to release focus, then reveal the saved row in its list. */
export async function revealEnvironmentItem(id: string): Promise<void> {
  await tick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const row = document.getElementById(`environment-item-${id}`);

  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: prefersReducedMotion.current ? "instant" : "smooth" });
  row.querySelector<HTMLElement>("[data-item-focus]")?.focus({ preventScroll: true });
  row.animate(
    [
      { backgroundColor: "color-mix(in srgb, var(--color-brand-500) 18%, transparent)" },
      { backgroundColor: "transparent" },
    ],
    {
      duration: prefersReducedMotion.current ? 0 : duration("very-slow") * 3,
      easing: getComputedStyle(row).getPropertyValue("--ease-smooth-out").trim(),
    },
  );
}
