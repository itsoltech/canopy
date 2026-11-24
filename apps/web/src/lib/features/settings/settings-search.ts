import { createContext } from "svelte";
import type { Attachment } from "svelte/attachments";
import { settingsSearchWords } from "./sections.ts";

export const [useSettingsSearch, provideSettingsSearch] = createContext<{
  readonly query: string;
  readonly panel: string | undefined;
}>();

/** Paint matches and surface the topic containing the most distinct search terms. */
export function highlightSettingsMatches(query: string, onmatch: (panel?: string) => void): Attachment<HTMLElement> {
  return (content) => {
    const words = settingsSearchWords(query);

    if (!words.length) {
      onmatch();

      return;
    }

    // Words contain only letters and digits. Prefer the longer match when two words share a prefix.
    const pattern = new RegExp(words.sort((a, b) => b.length - a.length).join("|"), "giu");

    const update = () => {
      const highlight = CSS.highlights && new Highlight();
      const topics = new Map<string, Set<string>>();

      for (const panel of content.querySelectorAll<HTMLElement>("[data-topic-keywords]")) {
        const matched = words.filter((word) => panel.dataset["topicKeywords"]?.includes(word));

        if (matched.length) topics.set(panel.id, new Set(matched));
      }

      const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node instanceof HTMLDialogElement) return NodeFilter.FILTER_REJECT;

          return node instanceof Text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const panel = node.parentElement?.closest<HTMLElement>("[data-settings-topic]")?.dataset["settingsTopic"];

        for (const match of (node.textContent ?? "").matchAll(pattern)) {
          if (panel) {
            const found = topics.get(panel) ?? new Set<string>();
            found.add(match[0].toLowerCase());
            topics.set(panel, found);
          }

          if (!highlight) continue;
          const range = new Range();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          highlight.add(range);
        }
      }

      onmatch([...topics].sort(([, a], [, b]) => b.size - a.size)[0]?.[0]);

      if (highlight) CSS.highlights.set("settings-search", highlight);
    };

    update();
    const observer = new MutationObserver(update);
    observer.observe(content, { childList: true, characterData: true, subtree: true });

    return () => {
      observer.disconnect();
      CSS.highlights?.delete("settings-search");
    };
  };
}
