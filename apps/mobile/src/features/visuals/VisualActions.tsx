import { useContext, useRef } from "react";
import { Platform } from "react-native";
import { create } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { ui, type Visual } from "@canopy/contracts";
import { compileVisualExport } from "@canopy/domain/visual-compiler";
import { useSession } from "../../state/session";
import { PickerSheet, type PickerSection } from "../../ui/Picker";
import { toast } from "../../ui/Toast";
import { exportFile } from "../attachments/export-file";
import { providerName } from "../models/catalog";
import { QuoteItem } from "../quotes/QuoteAction";
import { useTimelineDirectory } from "../timeline/directory";
import { loadVisual } from "./visual-source";

const exportLabel = Platform.OS === "android" ? "Save HTML" : "Share HTML";

/**
 * A visual's actions, all in the app's chrome (never inside the WebView): save or share the standalone HTML, copy
 * the spec, cite the version, pick an earlier version. Every action uses `version`, the one on screen.
 */
export function VisualActions({
  visual,
  version,
  versions,
  visible,
  onClose,
  onSelectVersion,
}: {
  visual: Visual;
  version: number;
  versions: readonly number[];
  visible: boolean;
  onClose: () => void;
  /** 0 follows the latest version. */
  onSelectVersion: (version: number) => void;
}) {
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const itemId = useContext(QuoteItem);
  const latest = versions.at(-1) ?? visual.version;
  // Sharing and saving present native UI, so actions run once the sheet has gone.
  const pending = useRef("");

  const load = () => {
    if (!client) throw new Error("offline");

    return loadVisual(client.api, directory.currentId, visual.visualId, version);
  };

  async function run(action: string) {
    try {
      const loaded = await load();
      const shown = loaded.visual ?? visual;

      if (action === "export") {
        const exported = compileVisualExport(shown, loaded.specJson, base64Encode(Crypto.getRandomBytes(18), "url"));

        if (!exported) throw new Error("not exportable");
        await exportFile(exported.name, new TextEncoder().encode(exported.html), "text/html");
      } else if (action === "copy") {
        await Clipboard.setStringAsync(JSON.stringify(JSON.parse(loaded.specJson), null, 2));
        toast("Spec copied");
      } else
        directory.quote?.(
          create(ui.QuoteSchema, {
            text: `Visual "${shown.title}" · Version ${version} (visual:${visual.visualId}@${version})\n${shown.description}`,
            sourceItemId: itemId,
            sourceThreadId: directory.currentId,
            sourceKind: "text_selection",
            sourceAuthor: providerName(directory.thread(directory.currentId)?.provider ?? 0),
            sourceTime: directory.quoteTime?.(itemId),
          }),
        );
    } catch {
      toast(
        action === "export"
          ? `Couldn't ${Platform.OS === "android" ? "save" : "share"} the HTML. Try again.`
          : action === "copy"
            ? "Couldn't copy the spec. Try again."
            : "Couldn't cite this visual. Try again.",
      );
    }
  }

  const sections: PickerSection<string>[] = [
    {
      options: [
        { value: "export", label: exportLabel, icon: "arrow-down" },
        { value: "copy", label: "Copy spec", icon: "document-duplicate" },
        ...(directory.quote && !directory.readOnly
          ? [{ value: "cite", label: "Cite visual", icon: "chat-bubble-left-right" as const }]
          : []),
      ],
    },
    ...(versions.length > 1
      ? [
          {
            title: "Versions",
            separator: true,
            options: [...versions].reverse().map((entry) => ({
              value: `version:${entry}`,
              label: `Version ${entry}`,
              ...(entry === latest && { badge: "Latest" }),
            })),
          },
        ]
      : []),
  ];

  return (
    <PickerSheet
      title="Visual actions"
      visible={visible}
      onClose={onClose}
      sections={sections}
      value={`version:${version}`}
      onSelect={(value) => {
        if (!value.startsWith("version:")) pending.current = value;
        else {
          const picked = Number(value.slice(8));
          onSelectVersion(picked === latest ? 0 : picked);
        }
      }}
      onDismiss={() => {
        const action = pending.current;
        pending.current = "";

        if (action) void run(action);
      }}
    />
  );
}
