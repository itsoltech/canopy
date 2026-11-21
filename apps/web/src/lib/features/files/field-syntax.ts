import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const fieldHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--code-property)" },
    { tag: tags.string, color: "var(--code-string)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-constant)" },
    { tag: tags.comment, color: "var(--code-comment)" },
  ]),
);

export async function loadFieldLanguage(filename: string) {
  const { languages } = await import("@codemirror/language-data");

  return LanguageDescription.matchFilename(languages, filename)?.load();
}
