import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, type AgentPreviewInput } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";

type Input = MessageInitShape<typeof AgentPreviewInputSchema>;

export type PreviewCommand = {
  label: string;
  icon?: IconName;
  inputs: Input[];
};

const scrollUp: PreviewCommand = {
  label: "Scroll up",
  icon: "arrow-up",
  inputs: [{ kind: "wheel", x: 0.5, y: 0.5, deltaY: -400 }],
};

const scrollDown: PreviewCommand = {
  label: "Scroll down",
  icon: "arrow-down",
  inputs: [{ kind: "wheel", x: 0.5, y: 0.5, deltaY: 400 }],
};

const back: PreviewCommand = { label: "Go back", icon: "chevron-left", inputs: [{ kind: "back" }] };
const forward: PreviewCommand = { label: "Go forward", icon: "chevron-right", inputs: [{ kind: "forward" }] };
const home: PreviewCommand = { label: "Go home", inputs: [{ kind: "home" }] };
const enter = key("Enter");
const escape = key("Escape");

function key(value: string): PreviewCommand {
  return {
    label: `Send ${value}`,
    inputs: [
      { kind: "key-down", key: value, code: value },
      { kind: "key-up", key: value, code: value },
    ],
  };
}

export function previewCommands(tool: AgentTool) {
  if (tool === AgentTool.BROWSER) return { quick: [back, forward, scrollUp, scrollDown], more: [enter, escape] };

  if (tool === AgentTool.DEVICE) return { quick: [back, home], more: [scrollUp, scrollDown, enter] };

  return { quick: [scrollUp, scrollDown], more: [enter, escape] };
}

export function sendPreviewInputs(input: (value: AgentPreviewInput) => void, inputs: readonly Input[]) {
  for (const values of inputs) input(create(AgentPreviewInputSchema, values));
}
