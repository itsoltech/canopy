import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { codeToTokensBase, createShikiPrimitive, getLastGrammarState, type GrammarState, type ShikiPrimitive } from "@shikijs/primitive";
import { grammars, type LanguageId } from "./languages.ts";
import type { LineTokenizer } from "./incremental.ts";
import { DEFAULT_COLOR, theme } from "./theme.ts";

/**
 * Shiki (TextMate grammars) on the JavaScript regex engine (no WASM). This module and every grammar load
 * on first use, from `highlight.svelte.ts`; one instance serves every code block.
 */
let shiki: ShikiPrimitive | undefined;
const loaded = new Map<LanguageId, Promise<LineTokenizer>>();

/** A tokenizer for one language, once its grammar (and the ones it embeds) loaded. */
export function tokenizer(lang: LanguageId): Promise<LineTokenizer> {
  let pending = loaded.get(lang);
  if (!pending) {
    pending = grammars[lang]().then(({ default: grammar }) => {
      shiki ??= createShikiPrimitive({ engine: createJavaScriptRegexEngine({ forgiving: true }), themes: [theme], langs: [] });
      const instance = shiki;
      instance.loadLanguageSync(grammar);
      const name = grammar.at(-1)?.name ?? lang;
      return (text, state) => {
        const lines = codeToTokensBase(instance, text, {
          lang: name,
          theme: theme.name,
          grammarState: state as GrammarState | undefined,
          // A pathological line stays plain instead of holding the main thread.
          tokenizeMaxLineLength: 2000,
          tokenizeTimeLimit: 50,
        });
        return {
          tokens: (lines[0] ?? []).map((token) => (token.color && token.color !== DEFAULT_COLOR ? { content: token.content, color: token.color } : { content: token.content })),
          state: getLastGrammarState(instance, lines),
        };
      };
    });
    loaded.set(lang, pending);
    pending.catch(() => loaded.delete(lang));
  }
  return pending;
}
