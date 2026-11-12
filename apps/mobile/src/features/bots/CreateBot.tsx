import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { BotSettings } from "./BotSettings";

/** Creation and editing share appearance, model and permission controls. */
export function CreateBot({ onClose }: { onClose: () => void }) {
  const [bot] = useState(() =>
    create(bots.BotSchema, {
      configuration: {
        shape: "round",
        color: "#8b5cf6",
        providerInstance: "native",
        approvalPolicy: "safe",
        threadPermission: "user_default",
      },
    }),
  );

  return <BotSettings bot={bot} creating onClose={onClose} />;
}
