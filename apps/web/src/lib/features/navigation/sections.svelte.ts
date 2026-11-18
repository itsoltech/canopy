import type { ReadonlyURL } from "$app/state";
import type { ModuleId } from "@canopy/domain";

export const sectionLabels: Record<ModuleId, string> = { threads: "Threads", bots: "Bots" };

export const sectionHome = (id: ModuleId): string => (id === "threads" ? "/threads/new" : "/bots");

/** Settings, the app entry point, and shared pages have no module of their own. */
export function sectionOf(pathname: string): ModuleId | undefined {
  const [, root] = pathname.split("/");

  if (root === "bots" || pathname === "/dev/bots") return "bots";

  if (
    ["threads", "projects", "pull-requests"].includes(root ?? "") ||
    pathname === "/dev/tool-calls" ||
    pathname === "/dev/long-thread"
  )
    return "threads";

  return undefined;
}

export function moduleRedirect(url: ReadonlyURL, enabled: readonly ModuleId[]): string | undefined {
  const home = sectionHome(enabled[0] ?? "threads");

  if (url.pathname === "/") {
    // Bookmarked project/workspace links from the original new-thread composer.
    if (enabled.includes("threads") && (url.searchParams.has("project") || url.searchParams.has("workspace")))
      return `${sectionHome("threads")}${url.search}${url.hash}`;

    return home;
  }

  const section = sectionOf(url.pathname);

  return section && !enabled.includes(section) ? home : undefined;
}

class SectionMemory {
  current = $state<ModuleId>();
  #last = $state<Partial<Record<ModuleId, string>>>({});

  visit(url: ReadonlyURL): void {
    const section = sectionOf(url.pathname);

    if (!section) return;
    this.current = section;
    this.#last[section] = `${url.pathname}${url.search}`;
  }

  href(section: ModuleId): string {
    return this.#last[section] ?? sectionHome(section);
  }
}

export const sectionMemory = new SectionMemory();
