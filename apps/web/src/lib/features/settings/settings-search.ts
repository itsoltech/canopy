import type { Attachment } from "svelte/attachments";
import { settingsSearchWords } from "./sections.ts";

/** Paint search matches without changing the DOM or focus of the settings controls. */
export function highlightSettingsMatches(query: string): Attachment<HTMLElement> {
  return (content) => {
    const words = settingsSearchWords(query);

    if (!words.length || !CSS.highlights) return;

    // Words contain only letters and digits. Prefer the longer match when two words share a prefix.
    const pattern = new RegExp(words.sort((a, b) => b.length - a.length).join("|"), "giu");

    const update = () => {
      const highlight = new Highlight();

      const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node instanceof HTMLDialogElement) return NodeFilter.FILTER_REJECT;

          return node instanceof Text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of (node.textContent ?? "").matchAll(pattern)) {
          const range = new Range();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          highlight.add(range);
        }
      }

      CSS.highlights.set("settings-search", highlight);
    };

    update();
    const observer = new MutationObserver(update);
    observer.observe(content, { childList: true, characterData: true, subtree: true });

    return () => {
      observer.disconnect();
      CSS.highlights.delete("settings-search");
    };
  };
}
