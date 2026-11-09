import { useMemo } from "react";
import { View } from "react-native";
import { lexMarkdown, withSentinels } from "@canopy/domain/markdown";
import { useColors } from "../theme";
import { Blocks } from "./Blocks";
import { MarkdownScopeProvider, type InlineElements } from "./scope";

/**
 * Markdown from agents, bots and people as native views (web: Markdown), from the same token tree as the web
 * (`@canopy/domain/markdown`). Nothing is HTML or a WebView: raw HTML shows as text, links open only http(s) and
 * mailto in the system apps, and images are never loaded (they show as links).
 *
 * `color`: the text colour of the whole message (commentary and reasoning are quieter; tinted bubbles pass their
 * tint, which also colours headings and bold). `breaks`: single newlines break the line (what people type).
 * `elements`: the caller's inline elements over ranges of `text` (mention badges).
 */
export function Markdown({
  text,
  color,
  breaks = false,
  elements,
  selectable = true,
}: {
  text: string;
  color?: string | undefined;
  breaks?: boolean;
  elements?: InlineElements | undefined;
  /** Chat bubbles supply their own long-press Reply/Copy menu. */
  selectable?: boolean;
}) {
  const c = useColors();
  const ranges = elements?.ranges;
  // By the ranges, not the elements: callers build `elements` on every render.
  const marked = useMemo(() => (ranges && ranges.length > 0 ? withSentinels(text, ranges) : undefined), [text, ranges]);
  const tokens = useMemo(() => lexMarkdown(marked?.text ?? text, breaks), [marked, text, breaks]);

  const scope = {
    selectable,
    ink: color ?? c.body,
    strong: color ?? c.text,
    restore: marked?.restore ?? ((code: string) => code),
    render: elements?.render,
  };

  return (
    <MarkdownScopeProvider value={scope}>
      <View style={{ gap: 12 }}>
        <Blocks tokens={tokens} />
      </View>
    </MarkdownScopeProvider>
  );
}
