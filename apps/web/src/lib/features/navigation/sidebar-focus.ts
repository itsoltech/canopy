import { tick } from "svelte";

/** Capture neighbours before archiving removes a row or moves it into the archive. */
export function focusAfterArchive(row: HTMLElement | undefined): () => void {
  const sidebar = row?.closest(".sidebar-scale");
  const rows = [...(sidebar?.querySelectorAll<HTMLElement>("[data-sidebar-archive-row]") ?? [])];
  const index = row ? rows.indexOf(row) : -1;
  const neighbours = [...rows.slice(index + 1), ...rows.slice(0, index).reverse()];

  return () => {
    void tick().then(() => {
      // Dialogs restore their origin after closing. Transfer focus after that restoration has settled.
      requestAnimationFrame(() => {
        const focused = document.activeElement;

        if (focused !== document.body && focused && !row?.contains(focused)) return;
        const next = neighbours.find((candidate) => candidate.isConnected && !candidate.closest("[inert]"));
        const target = next?.querySelector<HTMLElement>("a[href]") ?? sidebar?.querySelector<HTMLElement>("input");
        target?.focus({ preventScroll: true });
      });
    });
  };
}
