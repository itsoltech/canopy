import { useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { SyntaxRole } from "@canopy/contracts";
import { useColors, useTypography } from "../../ui/theme";
import { syntaxColors } from "../workspace/syntax-colors";

type Format = "JSON" | "TOML";

const jsonTokens =
  /("(?:\\.|[^"\\\r\n])*"(?=\s*:))|("(?:\\.|[^"\\\r\n])*"?)|(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?|\b(?:true|false|null)\b)/g;

const tomlTokens = new RegExp(
  [
    /(#[^\r\n]*)/,
    /((?:[\w-]+|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*')(?=[ \t]*=))/,
    /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\r\n])*"?|'[^'\r\n]*'?)/,
    /([-+]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[Ee][+-]?[\d_]+)?|\b(?:inf|nan)\b)|\b(?:true|false)\b)/,
    /[\w-]+/,
  ]
    .map((token) => token.source)
    .join("|"),
  "g",
);

const maxSourceLength = 16_384;
const maxSpans = 256;
const jsonRoles = [SyntaxRole.PROPERTY, SyntaxRole.STRING, SyntaxRole.CONSTANT];
const tomlRoles = [SyntaxRole.COMMENT, ...jsonRoles];

function highlight(value: string, format: Format, colors: ReturnType<typeof syntaxColors>): ReactNode {
  if (value.length > maxSourceLength) return value;
  const tokens = format === "JSON" ? jsonTokens : tomlTokens;
  const roles = format === "JSON" ? jsonRoles : tomlRoles;
  const children: ReactNode[] = [];
  let end = 0;
  let count = 0;

  for (const match of value.matchAll(tokens)) {
    const { 0: token, index } = match;
    const role = roles.find((_, group) => match[group + 1] !== undefined);

    if (role === undefined) continue;

    if (++count > maxSpans) return value;

    if (index > end) children.push(value.slice(end, index));

    children.push(
      <Text key={index} style={{ color: colors[role] }}>
        {token}
      </Text>,
    );
    end = index + token.length;
  }

  children.push(value.slice(end));

  return children;
}

export function ProviderSettingsCode({ value, format }: { value: string; format: Format }) {
  const c = useColors();
  const type = useTypography();
  const contents = useMemo(() => highlight(value, format, syntaxColors(c)), [value, format, c]);

  return (
    <Text selectable style={[type.mono, { color: c.text, backgroundColor: c.inset, padding: 8, borderRadius: 6 }]}>
      {contents}
    </Text>
  );
}
