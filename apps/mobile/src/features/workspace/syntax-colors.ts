import { SyntaxRole } from "@canopy/contracts";
import { palette } from "@canopy/ui";
import type { Colors } from "../../ui/theme";

/** Semantic palette matches web contrast steps; no parser or HTML reaches the phone. */
export function syntaxColors(c: Colors): Readonly<Record<SyntaxRole, string>> {
  const step = c.dark ? 300 : 700;

  return {
    [SyntaxRole.UNSPECIFIED]: c.text,
    [SyntaxRole.COMMENT]: c.muted,
    [SyntaxRole.KEYWORD]: palette.violet[step],
    [SyntaxRole.PUNCTUATION]: c.muted,
    [SyntaxRole.STRING]: palette.emerald[step],
    [SyntaxRole.REGEXP]: palette.teal[step],
    [SyntaxRole.CONSTANT]: palette.amber[step],
    [SyntaxRole.FUNCTION]: palette.sky[step],
    [SyntaxRole.TYPE]: palette.orange[step],
    [SyntaxRole.TAG]: palette.rose[step],
    [SyntaxRole.PROPERTY]: palette.cyan[c.dark ? 200 : 800],
    [SyntaxRole.INSERTED]: palette.emerald[step],
    [SyntaxRole.DELETED]: palette.rose[step],
  };
}
