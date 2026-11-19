import { useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import type { Token } from "marked";
import { isMathToken, isToken, snippetTokens } from "@canopy/domain/markdown";
import { useTypography } from "../theme";
import { Faced } from "./text-style";

/** Passive text inside the row's own single-line Text. Bound the native spans for long messages. */
export function MarkdownSnippet({ text }: { text: string }) {
  const mono = useTypography().mono.fontFamily;

  return useMemo(() => {
    let remaining = 512;

    function runs(tokens: readonly Token[]): ReactNode[] {
      const result: ReactNode[] = [];

      for (const token of tokens) {
        if (remaining <= 0) break;
        const key = result.length;

        if (isToken(token, "strong") || isToken(token, "em")) {
          result.push(
            <Faced
              key={key}
              weight={token.type === "strong" ? "semibold" : undefined}
              italic={token.type === "em" || undefined}
            >
              {runs(token.tokens)}
            </Faced>,
          );
        } else if (isToken(token, "del")) {
          result.push(
            <Text key={key} style={{ textDecorationLine: "line-through" }}>
              {runs(token.tokens)}
            </Text>,
          );
        } else if (isToken(token, "text") && token.tokens) {
          result.push(runs(token.tokens));
        } else if (
          isToken(token, "text") ||
          isToken(token, "escape") ||
          isToken(token, "codespan") ||
          isMathToken(token)
        ) {
          const value = token.text.replace(/\s+/g, " ");
          const visible = value.length > remaining ? value.slice(0, remaining) + "…" : value;
          remaining -= value.length;
          result.push(
            isToken(token, "codespan") ? (
              <Text key={key} style={{ fontFamily: mono }}>
                {visible}
              </Text>
            ) : (
              visible
            ),
          );
        }
      }

      return result;
    }

    return runs(snippetTokens(text));
  }, [text, mono]);
}
