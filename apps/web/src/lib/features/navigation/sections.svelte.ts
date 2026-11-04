/**
 * The sidebar's sections: Threads (coding agents on workers) and Bots (agents in the gateway). The
 * active one follows the route; switching goes back to the last page you had open in that section
 * (kept in memory for this tab) or to its home.
 */
export type Section = "threads" | "bots";

export const sections: readonly { id: Section; label: string; home: string }[] = [
  { id: "threads", label: "Threads", home: "/" },
  { id: "bots", label: "Bots", home: "/bots" },
];

/** Section of a page; Settings belongs to none (the sidebar keeps the last one). */
export function sectionOf(pathname: string): Section | undefined {
  if (pathname.startsWith("/settings")) return undefined;

  return pathname === "/bots" || pathname.startsWith("/bots/") ? "bots" : "threads";
}

class SectionMemory {
  /** Section of the last page outside Settings. */
  current = $state<Section>("threads");
  #last = $state<Partial<Record<Section, string>>>({});

  /** Remembers a visited page (called after every navigation). */
  visit(url: URL): void {
    const section = sectionOf(url.pathname);

    if (!section) return;
    this.current = section;
    this.#last[section] = `${url.pathname}${url.search}`;
  }

  /** Where switching to `section` goes. */
  href(section: Section): string {
    return this.#last[section] ?? sections.find((s) => s.id === section)!.home;
  }
}

export const sectionMemory = new SectionMemory();
