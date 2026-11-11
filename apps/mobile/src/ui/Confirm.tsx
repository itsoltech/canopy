import { useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "./Button";
import { Overlay } from "./Overlay";
import { SheetDragArea } from "./SheetDragArea";
import { font, useColors, useTypography } from "./theme";

interface Request {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly danger: boolean;
  readonly action: () => void;
}

let current: Request | undefined;
const listeners = new Set<() => void>();

function set(next: Request | undefined) {
  current = next;

  for (const listener of listeners) listener();
}

/**
 * Asks before an action (web: a confirmation Dialog). The title is a question, the button repeats its verb and is
 * `danger` unless the action is harmless to undo.
 */
export function confirm(request: {
  title: string;
  description: string;
  confirm: string;
  danger?: boolean;
  action: () => void;
}) {
  set({ danger: true, ...request });
}

/** The single confirmation dialog of the app; mounted once in the root layout. */
export function ConfirmHost() {
  const c = useColors();
  const type = useTypography();

  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => current,
  );

  const close = () => set(undefined);

  return (
    <Overlay visible={Boolean(request)} onClose={close} label={request?.title ?? "Confirm"}>
      {request && (
        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 16, flexShrink: 1 }}>
          <SheetDragArea style={{ gap: 4 }}>
            <Text
              accessibilityRole="header"
              style={[type.body, { fontSize: 18, lineHeight: 28, fontFamily: font.semibold, color: c.text }]}
            >
              {request.title}
            </Text>
          </SheetDragArea>
          <ScrollView style={{ flexGrow: 0, flexShrink: 1 }}>
            <Text style={[type.body, { color: c.muted }]}>{request.description}</Text>
          </ScrollView>
          {/* Web: DialogActions, stacked on phones with the action on top. */}
          <View style={{ flexDirection: "column-reverse", gap: 8 }}>
            <Button title="Cancel" onPress={close} />
            <Button
              title={request.confirm}
              variant={request.danger ? "danger" : "primary"}
              onPress={() => {
                close();
                request.action();
              }}
            />
          </View>
        </View>
      )}
    </Overlay>
  );
}
