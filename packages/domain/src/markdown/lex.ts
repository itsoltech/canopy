import { Marked, type Token, type Tokens } from "marked";
import { mathExtensions } from "./math.ts";

/** `breaks`: a single newline is a line break (people's messages), not a soft wrap (agents' markdown). */
const markdown = new Marked({ extensions: mathExtensions });

/** Markdown as marked's token tree (GFM, with `$…$` and `$$…$$` math), the same on the web and the phone. */
export const lexMarkdown = (text: string, breaks = false): Token[] =>
  markdown.lexer(text, { ...markdown.defaults, gfm: true, breaks });

/** The marked tokens read by their `type`. */
interface TokenTypes {
  readonly blockquote: Tokens.Blockquote;
  readonly br: Tokens.Br;
  readonly code: Tokens.Code;
  readonly codespan: Tokens.Codespan;
  readonly del: Tokens.Del;
  readonly em: Tokens.Em;
  readonly escape: Tokens.Escape;
  readonly heading: Tokens.Heading;
  readonly html: Tokens.HTML | Tokens.Tag;
  readonly image: Tokens.Image;
  readonly link: Tokens.Link;
  readonly list: Tokens.List;
  readonly paragraph: Tokens.Paragraph;
  readonly strong: Tokens.Strong;
  readonly table: Tokens.Table;
  readonly text: Tokens.Text;
}

/** marked's token of a `type` is that type's interface (a `list` token is a `Tokens.List`). */
export const isToken = <K extends keyof TokenTypes>(token: Token, type: K): token is TokenTypes[K] =>
  token.type === type;
