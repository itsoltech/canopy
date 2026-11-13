import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import {
  codeToTokensBase,
  createShikiPrimitive,
  getLastGrammarState,
  type GrammarState,
  type ShikiPrimitive,
} from "@shikijs/primitive";
import { grammars, type LanguageId } from "./languages.ts";
import type { LineTokenizer } from "./incremental.ts";
import { DEFAULT_COLOR, theme } from "./theme.ts";

/**
 * Shiki (TextMate grammars) on the JavaScript regex engine (no WASM). This module and every grammar load
 * on first use; each executor owns one instance.
 */
let shiki: ShikiPrimitive | undefined;

/** Per language, the grammar's scope name once it (and the ones it embeds) loaded. */
const loaded = new Map<LanguageId, Promise<string>>();

function load(lang: LanguageId): Promise<string> {
  let pending = loaded.get(lang);

  if (!pending) {
    pending = grammars[lang]().then(({ default: grammar }) => {
      shiki ??= createShikiPrimitive({
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        themes: [theme],
        langs: [],
      });
      shiki.loadLanguageSync(grammar);

      return grammar.at(-1)?.name ?? lang;
    });
    loaded.set(lang, pending);
    pending.catch(() => loaded.delete(lang));
  }

  return pending;
}

/**
 * A tokenizer for one language, once its grammar loaded. A line taking longer than `timeLimitMs` (default 50, 0 = no
 * limit) stays plain: a pathological line does not hold the main thread, but under load an ordinary one may too.
 */
export async function tokenizer(
  lang: LanguageId,
  { timeLimitMs = 50 }: { timeLimitMs?: number } = {},
): Promise<LineTokenizer> {
  const name = await load(lang);
  const instance = shiki!;

  return (text, state) => {
    const lines = codeToTokensBase(instance, text, {
      lang: name,
      theme: "canopy",
      ...(state && { grammarState: state }),
      tokenizeMaxLineLength: 2000,
      tokenizeTimeLimit: timeLimitMs,
    });

    return {
      tokens: (lines[0] ?? []).map((token) =>
        token.color && token.color !== DEFAULT_COLOR
          ? { content: token.content, color: token.color }
          : { content: token.content },
      ),
      // SAFETY: the state is the GrammarState instance codeToTokensBase built for these lines; @shikijs/types
      // declares only its public interface, not the class codeToTokensBase takes back.
      state: getLastGrammarState(instance, lines) as GrammarState | undefined,
    };
  };
}
