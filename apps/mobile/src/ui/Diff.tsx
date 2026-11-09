import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { Segmented } from "./components";
import { styles, useColors } from "./theme";
import { DiffContent } from "./DiffContent";
import { INLINE_PREVIEW } from "../features/viewers/TextViewer";
import { TextViewerButton } from "../features/viewers/TextViewerButton";
import { QuoteAction } from "../features/quotes/QuoteAction";
import { CopyAction } from "../features/viewers/copy-action";

/** `bare`: always open, without its own header (the row above it names the file and opens or folds it). */
export function Diff({
  diff,
  label = "File changes",
  bare = false,
  selectable = true,
}: {
  diff: string;
  label?: string;
  bare?: boolean;
  selectable?: boolean;
}) {
  const c = useColors();
  const { values, set } = useDevicePreferences();
  const [open, setOpen] = useState(values.diffFileState !== "collapsed");

  return (
    <View accessibilityLabel={label} style={{ gap: 8 }}>
      {!bare && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={[styles.chrome, { color: c.text }]}>
            {open ? "▾" : "▸"} {label}
          </Text>
        </Pressable>
      )}
      {(open || bare) && (
        <>
          <Segmented
            value={values.diffLayout}
            options={[
              { value: "stacked", label: "Stacked" },
              { value: "split", label: "Side by side" },
            ]}
            onChange={(value) => set("diffLayout", value)}
          />
          <View style={{ borderRadius: 8, overflow: "hidden", paddingVertical: 8, backgroundColor: c.inset }}>
            <DiffContent diff={diff.slice(0, INLINE_PREVIEW)} selectable={selectable} />
          </View>
          {diff.length > INLINE_PREVIEW ? <TextViewerButton text={diff} label={label} diff /> : null}
          <View style={[styles.row, { minHeight: 32, gap: 8 }]}>
            <CopyAction text={diff} label="Copy diff" />
            <QuoteAction text={diff} kind="diff" language="diff" />
          </View>
        </>
      )}
    </View>
  );
}
