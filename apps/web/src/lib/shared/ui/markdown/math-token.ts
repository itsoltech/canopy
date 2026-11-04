import type { Token, TokenizerExtension } from "marked";

export interface MathToken {
  type: "math";
  raw: string;
  text: string;
  display: boolean;
}

export function isMathToken(token: Token): token is MathToken {
  return token.type === "math";
}

export const mathExtensions: TokenizerExtension[] = [
  {
    name: "math",
    level: "block",
    start: (source) => source.indexOf("$$"),
    tokenizer(source) {
      const found = /^\$\$\s*\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(source);

      if (found) return { type: "math", raw: found[0], text: found[1]!.trim(), display: true } satisfies MathToken;

      return undefined;
    },
  },
  {
    name: "math",
    level: "inline",
    start: (source) => source.indexOf("$"),
    tokenizer(source) {
      const found = /^\$(?!\s|\$)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(source);

      if (found) return { type: "math", raw: found[0], text: found[1]!, display: false } satisfies MathToken;

      return undefined;
    },
  },
];
