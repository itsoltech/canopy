import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { Token } from "marked";
import { isMathToken, isToken } from "@canopy/domain/markdown";
import { Diff } from "../Diff";
import { useColors, useTypography } from "../theme";
import { CodeFence, SidewaysScroll } from "./CodeFence";
import { Inline } from "./Inline";
import { MarkdownList } from "./MarkdownList";
import { MarkdownTable } from "./MarkdownTable";
import { MarkdownScopeProvider, useMarkdownScope } from "./scope";
import { Faced } from "./text-style";

/** Heading sizes over the body's (web: text-lg/7, text-base/7, then text-base/6), as [size, line height]. */
const HEADING: ReadonlyMap<number, readonly [number, number]> = new Map([
  [1, [18, 28]],
  [2, [16, 28]],
]);

function Heading({ depth, tokens }: { depth: number; tokens: Token[] }) {
  const type = useTypography();
  const { strong } = useMarkdownScope();
  const scale = type.body.fontSize / 16;
  const [size, line] = HEADING.get(depth) ?? [16, 24];

  return (
    <Faced
      selectable
      weight="semibold"
      accessibilityRole="header"
      style={[type.body, { fontSize: size * scale, lineHeight: line * scale, color: strong }]}
    >
      <Inline tokens={tokens} />
    </Faced>
  );
}

/** A paragraph-like run of text in the message's colour. */
function Prose({ children }: { children: ReactNode }) {
  const type = useTypography();
  const { ink } = useMarkdownScope();

  return (
    <Text selectable style={[type.body, { color: ink }]}>
      {children}
    </Text>
  );
}

/** Display math as its TeX source on one scrolling line (the phone does not typeset it). */
function DisplayMath({ raw }: { raw: string }) {
  const type = useTypography();
  const { strong } = useMarkdownScope();

  return (
    <SidewaysScroll>
      <Text selectable style={[type.mono, { color: strong }]}>
        {raw}
      </Text>
    </SidewaysScroll>
  );
}

function Block({ token }: { token: Token }) {
  const c = useColors();
  const { restore } = useMarkdownScope();

  if (isMathToken(token)) return token.display ? <DisplayMath raw={token.raw} /> : <Prose>{token.raw}</Prose>;

  if (isToken(token, "paragraph"))
    return (
      <Prose>
        <Inline tokens={token.tokens} />
      </Prose>
    );

  if (isToken(token, "heading")) return <Heading depth={token.depth} tokens={token.tokens} />;

  if (isToken(token, "code"))
    return token.lang === "diff" ? (
      <Diff diff={restore(token.text)} />
    ) : (
      <CodeFence code={restore(token.text)} lang={token.lang || undefined} />
    );

  if (isToken(token, "list")) return <MarkdownList list={token} Blocks={Blocks} />;

  if (isToken(token, "blockquote"))
    return (
      <View style={{ borderLeftWidth: 2, borderColor: c.line, paddingLeft: 12, gap: 8 }}>
        <Blocks tokens={token.tokens} quiet />
      </View>
    );

  if (isToken(token, "table")) return <MarkdownTable table={token} />;

  if (token.type === "hr") return <View style={{ height: 1, backgroundColor: c.rule }} />;

  if (isToken(token, "text")) return <Prose>{token.tokens ? <Inline tokens={token.tokens} /> : token.text}</Prose>;

  // Raw HTML shows as the text it is.
  if (isToken(token, "html")) return <Prose>{token.raw.trimEnd()}</Prose>;

  return null;
}

/**
 * Block tokens of a message (web: MarkdownBlocks). `quiet`: inside a quote, where the text steps down to the
 * muted colour (web: text-zinc-600 / 400).
 */
export function Blocks({ tokens, quiet = false }: { tokens: readonly Token[]; quiet?: boolean }) {
  const c = useColors();
  const scope = useMarkdownScope();
  const blocks = tokens.map((token, index) => <Block key={index} token={token} />);

  return quiet ? <MarkdownScopeProvider value={{ ...scope, ink: c.muted }}>{blocks}</MarkdownScopeProvider> : blocks;
}
