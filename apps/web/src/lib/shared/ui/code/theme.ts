import type { ThemeRegistration } from "@shikijs/primitive";

/**
 * Syntax colours as CSS variables (`--code-*`, set for light and dark in `syntax.css`): code is tokenized
 * once and switching the colour scheme only swaps the variables. No bold or italic, so colouring a line
 * never changes its width. The scope rules follow GitHub's themes, folded into a few roles.
 */
export const DEFAULT_COLOR = "var(--code-fg)";

const role = (name: string) => ({ foreground: `var(--code-${name})` });

export const theme: ThemeRegistration = {
  name: "open-agents",
  type: "dark",
  fg: DEFAULT_COLOR,
  bg: "transparent",
  settings: [
    { settings: { foreground: DEFAULT_COLOR, background: "transparent" } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment", "string.quoted.docstring"], settings: role("comment") },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "variable.language", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.logical.python", "keyword.operator.word", "punctuation.definition.template-expression", "markup.heading", "entity.name.section"],
      settings: role("keyword"),
    },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator.key-value"], settings: role("punctuation") },
    {
      scope: ["string", "punctuation.definition.string", "string punctuation.section.embedded source", "markup.inline.raw", "markup.fenced_code", "string.unquoted.plain.out.yaml"],
      settings: role("string"),
    },
    { scope: ["string.regexp", "constant.character.escape", "constant.other.character-class.regexp"], settings: role("regexp") },
    {
      scope: ["constant", "constant.numeric", "constant.language", "constant.character", "constant.other", "variable.other.constant", "variable.other.enummember", "support.constant", "source.shell variable.other", "punctuation.definition.variable.shell"],
      settings: role("constant"),
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "variable.function", "entity.name.command", "markup.underline.link", "meta.diff.range", "meta.diff.header"],
      settings: role("function"),
    },
    {
      scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "entity.other.inherited-class", "support.type", "support.class", "storage.type.primitive", "storage.type.built-in", "entity.name.type.module"],
      settings: role("type"),
    },
    { scope: ["entity.name.tag", "support.type.property-name.css"], settings: role("tag") },
    { scope: ["entity.other.attribute-name", "meta.object-literal.key", "support.type.property-name", "variable.other.property", "entity.name.tag.yaml", "keyword.other.definition.ini", "entity.name.label"], settings: role("property") },
    { scope: ["source.css entity.other.attribute-name", "entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css"], settings: role("function") },
    { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: role("inserted") },
    { scope: ["markup.deleted", "punctuation.definition.deleted", "invalid"], settings: role("deleted") },
  ],
};
