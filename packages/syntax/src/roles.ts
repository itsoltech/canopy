import { SyntaxRole } from "@canopy/contracts";

/** Theme-independent roles; importing this module never loads a grammar or tokenizer. */
export const roleNames: Readonly<Record<SyntaxRole, string>> = {
  [SyntaxRole.UNSPECIFIED]: "fg",
  [SyntaxRole.COMMENT]: "comment",
  [SyntaxRole.KEYWORD]: "keyword",
  [SyntaxRole.PUNCTUATION]: "punctuation",
  [SyntaxRole.STRING]: "string",
  [SyntaxRole.REGEXP]: "regexp",
  [SyntaxRole.CONSTANT]: "constant",
  [SyntaxRole.FUNCTION]: "function",
  [SyntaxRole.TYPE]: "type",
  [SyntaxRole.TAG]: "tag",
  [SyntaxRole.PROPERTY]: "property",
  [SyntaxRole.INSERTED]: "inserted",
  [SyntaxRole.DELETED]: "deleted",
};
