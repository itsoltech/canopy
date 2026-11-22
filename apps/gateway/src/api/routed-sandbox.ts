import type { DescMethod, Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "../computers/remote.ts";
import {
  LINKED_DRAFT_SANDBOX_SNAPSHOT,
  LINKED_SCHEDULE_SANDBOX_PROFILES,
  LINKED_SANDBOX_PROFILES,
} from "../computers/capabilities.ts";

function changesScheduleSandbox(method: DescMethod, request: Message): boolean {
  if (method.name === "CreateSchedule") {
    const spec = linkedMessage(ui.CreateScheduleRequestSchema, request).newThread;

    return Boolean(spec?.sandboxProfileId || spec?.sandboxProfile);
  }

  if (method.name === "UpdateSchedule") {
    const spec = linkedMessage(ui.UpdateScheduleRequestSchema, request).configuration?.newThread;

    return spec?.sandboxProfileId !== undefined || Boolean(spec?.sandboxProfile);
  }

  return false;
}

export function requireLinkedSandboxProfiles(capabilities: readonly string[], method: DescMethod, request: Message) {
  if (
    (method.name === "CreateThread" || method.name === "CreateThreadWithProgress") &&
    linkedMessage(ui.CreateThreadRequestSchema, request).sandboxProfileDigest &&
    !capabilities.includes(LINKED_DRAFT_SANDBOX_SNAPSHOT)
  )
    throw new ConnectError(
      "Update Canopy on the linked computer to send this draft with its sandbox profile.",
      Code.FailedPrecondition,
    );

  const sandboxSelection =
    method.name === "UpdateThread"
      ? linkedMessage(ui.UpdateThreadRequestSchema, request).sandboxProfileId !== undefined
      : (method.name === "CreateThread" || method.name === "CreateThreadWithProgress") &&
        Boolean(linkedMessage(ui.CreateThreadRequestSchema, request).sandboxProfileId);

  if (sandboxSelection && !capabilities.includes(LINKED_SANDBOX_PROFILES))
    throw new ConnectError("Update Canopy on the linked computer to use sandbox profiles.", Code.FailedPrecondition);

  if (changesScheduleSandbox(method, request) && !capabilities.includes(LINKED_SCHEDULE_SANDBOX_PROFILES))
    throw new ConnectError(
      "Update Canopy on the linked computer to use sandbox profiles in schedules.",
      Code.FailedPrecondition,
    );
}
