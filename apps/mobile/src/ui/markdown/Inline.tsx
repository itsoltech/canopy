import { Fragment, type ReactNode } from "react";
import { Linking, Text } from "react-native";
import type { Token } from "marked";
import { hasSentinel, isMathToken, isToken, safeHref, splitSentinels } from "@canopy/domain/markdown";
import { isString } from "@canopy/domain/json";
import { useColors, useTypography } from "../theme";
import { useMarkdownScope } from "./scope";
import { Faced } from "./text-style";
import { fileHrefOf, filePathOf } from "@canopy/domain/file-references";
import { useFileLinks } from "./file-links";

/** Opens only what `safeHref` allows (http, https, mailto) in the system browser or mail app. */
function open(href: string) {
  void Linking.openURL(href).catch(() => undefined);
}

/** A link the reader can tap; unsafe targets (javascript:, data:, relative paths) stay plain text. */
function Link({ href, children }: { href: string; children: ReactNode }) {
  const c = useColors();
  const safe = safeHref(href);
  const files = useFileLinks();
  const path = files ? fileHrefOf(href) : undefined;

  if (!safe && !path) return <>{children}</>;

  return (
    <Faced
      weight="medium"
      accessibilityRole="link"
      accessibilityHint={path ? `Open ${path}` : safe}
      onPress={() => {
        if (files && path) files(path);
        else if (safe) open(safe);
      }}
      style={{ color: c.sky, textDecorationLine: "underline", textDecorationColor: `${c.sky}4d` }}
    >
      {children}
    </Faced>
  );
}

/** Text with the caller's elements drawn where their sentinels are. */
function Plain({ text }: { text: string }) {
  const { render } = useMarkdownScope();

  if (!render || !hasSentinel(text)) return <>{text}</>;

  return splitSentinels(text).map((part, index) => (
    <Fragment key={index}>{isString(part) ? part : render(part)}</Fragment>
  ));
}

/** One inline token as text or a nested `Text`. */
function InlineToken({ token }: { token: Token }) {
  const c = useColors();
  const type = useTypography();
  const { strong, restore } = useMarkdownScope();
  const files = useFileLinks();

  if (isMathToken(token)) return <Text style={{ fontFamily: type.mono.fontFamily, color: strong }}>{token.raw}</Text>;

  if (isToken(token, "strong"))
    return (
      <Faced weight="semibold" style={{ color: strong }}>
        <Inline tokens={token.tokens} />
      </Faced>
    );

  if (isToken(token, "em"))
    return (
      <Faced italic>
        <Inline tokens={token.tokens} />
      </Faced>
    );

  if (isToken(token, "del"))
    return (
      <Text style={{ textDecorationLine: "line-through" }}>
        <Inline tokens={token.tokens} />
      </Text>
    );

  if (isToken(token, "codespan")) {
    const text = restore(token.text);
    const path = files ? filePathOf(text) : undefined;

    return (
      <Text
        accessibilityRole={path ? "link" : undefined}
        accessibilityHint={path ? `Open ${path}` : undefined}
        onPress={files && path ? () => files(path) : undefined}
        style={{
          fontFamily: type.mono.fontFamily,
          fontSize: type.body.fontSize * 0.875,
          color: path ? c.sky : strong,
          textDecorationLine: path ? "underline" : undefined,
          backgroundColor: c.rule,
        }}
      >
        {text}
      </Text>
    );
  }

  if (isToken(token, "link"))
    return (
      <Link href={token.href}>
        <Inline tokens={token.tokens} />
      </Link>
    );

  if (isToken(token, "image")) return <Link href={token.href}>{token.text || safeHref(token.href) || ""}</Link>;

  if (token.type === "br") return "\n";

  if (isToken(token, "text") && token.tokens) return <Inline tokens={token.tokens} />;

  if (isToken(token, "text") || isToken(token, "escape")) return <Plain text={token.text} />;

  return token.raw;
}

/**
 * A run of inline tokens inside one `Text` (web: MarkdownInline). Nothing becomes HTML: raw tags show as text,
 * images show as a link to them (never loaded), math as its TeX source.
 */
export function Inline({ tokens }: { tokens: readonly Token[] }) {
  return tokens.map((token, index) => <InlineToken key={index} token={token} />);
}
