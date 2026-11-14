import { useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "./Button";
import { Overlay } from "./Overlay";
import { SheetDragArea } from "./SheetDragArea";
import { font, useColors, useTypography } from "./theme";
import { layerHost, layerShown, overlayShown, ROOT_OVERLAY, subscribeOverlays } from "./overlay-stack";

interface Request {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly danger: boolean;
  readonly action: () => void;
  /** The overlay it presents in; pinned once the dialog is on screen. */
  readonly host: string;
}

let current: Request | undefined;
const listeners = new Set<() => void>();

function set(next: Request | undefined) {
  current = next;

  for (const listener of listeners) listener();
}

/**
 * A second modal presented from the app window while a sheet is open is refused by UIKit yet stays mounted in
 * React Native, so the dialog presents inside the topmost open overlay. A host that closes before the dialog
 * appears hands it on; one that closes under the dialog takes it along.
 */
function place() {
  if (!current || overlayShown(current.host)) return;

  if (layerShown()) set(undefined);
  else set({ ...current, host: layerHost() });
}

subscribeOverlays(place);

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
  // The caller may close its own overlay in the same event; place it once that update has committed.
  set({ danger: true, ...request, host: current?.host ?? layerHost() });
  setTimeout(place);
}

/** The app's confirmation dialog; the root layout and every overlay render it, and only its host shows it. */
export function ConfirmHost({ host = ROOT_OVERLAY }: { host?: string }) {
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
  const visible = request?.host === host;

  return (
    <Overlay visible={visible} onClose={close} label={request?.title ?? "Confirm"} layer={false}>
      {request && visible && (
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
