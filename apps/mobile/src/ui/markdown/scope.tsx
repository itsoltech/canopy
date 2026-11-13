import { createContext, useContext, type ReactNode } from "react";
import type { SentinelRange } from "@canopy/domain/markdown";
import type { GitHubImage } from "@canopy/domain/github-images";

/** Elements a caller draws inside the text over ranges of the source (mention badges; `@canopy/domain/markdown`). */
export interface InlineElements {
  readonly ranges: readonly SentinelRange[];
  /** The element for that index of `ranges`: a `Text`, as it sits inside a line. */
  readonly render: (index: number) => ReactNode;
}

/** What every block and inline run of one message reads: its text colour, and the caller's inline elements. */
export interface MarkdownScope {
  readonly image?: ((value: GitHubImage) => ReactNode) | undefined;
  readonly selectable: boolean;
  /** Body text colour (commentary, reasoning and tinted bubbles are quieter or tinted). */
  readonly ink: string;
  /** Headings, bold and inline code: the strongest text colour, or the tint of a tinted bubble. */
  readonly strong: string;
  /** Code text with each sentinel back to the source it replaced. */
  readonly restore: (code: string) => string;
  readonly render: ((index: number) => ReactNode) | undefined;
}

const Scope = createContext<MarkdownScope>({
  selectable: true,
  ink: "",
  strong: "",
  restore: (code) => code,
  render: undefined,
});

export const MarkdownScopeProvider = Scope.Provider;
export const useMarkdownScope = () => useContext(Scope);
