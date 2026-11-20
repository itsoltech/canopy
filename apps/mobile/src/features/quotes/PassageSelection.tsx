import { useContext, useMemo, useRef } from "react";
import { Alert, Text, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { QUOTE_LIMITS } from "@canopy/domain";
import { escapeHtml } from "@canopy/domain/visual-compiler";
import { Sheet } from "../../ui/components";
import { SheetDragContext } from "../../ui/SheetDragArea";
import { useColors, useTypography } from "../../ui/theme";
import { copyText } from "../viewers/useCopyText";

const copy = { key: "copyPassage", label: "Copy" };
const quote = { key: "quotePassage", label: "Quote selection" };

interface SelectionProps {
  text: string;
  onQuote?: ((text: string) => void) | undefined;
}

/** One read-only document lets native selection handles span paragraphs and code blocks. */
function SelectablePassage({ text, onQuote }: SelectionProps) {
  const { close } = useContext(SheetDragContext);
  const c = useColors();
  const { body } = useTypography();
  const { fontScale } = useWindowDimensions();

  const source = useMemo(
    () => ({
      html: `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root { color-scheme: ${c.dark ? "dark" : "light"}; background: ${c.overlay}; color: ${c.text}; }
body { margin: 12px 20px 24px; font: ${body.fontSize * fontScale}px/${body.lineHeight * fontScale}px system-ui, sans-serif; }
main { white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body><main dir="auto">${escapeHtml(text)}</main></body></html>`,
    }),
    [text, c.dark, c.overlay, c.text, body.fontSize, body.lineHeight, fontScale],
  );

  return (
    <WebView
      source={source}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      allowFileAccess={false}
      // Android Fabric expects an array even for a single detector setting.
      dataDetectorTypes={["none"]}
      allowsLinkPreview={false}
      domStorageEnabled={false}
      textZoom={100}
      menuItems={onQuote ? [copy, quote] : [copy]}
      onCustomMenuSelection={async ({ nativeEvent: { key, selectedText } }) => {
        if (!selectedText) return;

        if (key === copy.key) {
          if (await copyText(selectedText)) close();
        } else if (key === quote.key && onQuote && selectedText.trim()) {
          if (selectedText.length > QUOTE_LIMITS.maxTextChars) {
            Alert.alert("Quote is too long", "Select up to 20,000 characters.");

            return;
          }

          onQuote(selectedText);
          close();
        }
      }}
      style={{ backgroundColor: c.overlay }}
    />
  );
}

export function PassageSelection({ text, onQuote, onClose }: SelectionProps & { onClose: () => void }) {
  const selected = useRef<string>(undefined);
  const c = useColors();
  const type = useTypography();

  return (
    <Sheet
      visible
      title="Select text"
      scroll={false}
      onClose={() => {
        onClose();

        if (selected.current !== undefined) onQuote?.(selected.current);
      }}
    >
      <Text style={[type.small, { color: c.muted, marginHorizontal: 20 }]}>
        Touch and hold a word, then drag the handles.
      </Text>
      <SelectablePassage
        text={text}
        onQuote={
          onQuote &&
          ((value) => {
            selected.current = value;
          })
        }
      />
    </Sheet>
  );
}
