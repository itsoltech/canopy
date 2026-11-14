/**
 * Visual spec v1: a versioned component tree the trusted kit renders (docs/agent-visuals.md §3).
 * Types only, shared by the validator, the compiler and the in-frame kit runtime.
 */
export type VisualTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

export type VisualGap = "xs" | "sm" | "md" | "lg";

export type VisualStateValue = string | boolean | number;

export type VisualAction =
  | { readonly action: "set"; readonly state_key: string; readonly value: VisualStateValue }
  | { readonly action: "next" | "previous" | "toggle"; readonly state_key: string }
  | { readonly action: "reset" };

export interface VisualOption {
  readonly value: string;
  readonly label: string;
}

export interface VisualPanel {
  readonly value: string;
  readonly label: string;
  readonly children: readonly VisualNode[];
}

export interface VisualStep {
  readonly title: string;
  readonly description?: string;
  readonly children?: readonly VisualNode[];
}

export type VisualDevice = "phone" | "tablet" | "desktop" | "browser";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

export type ButtonSize = "sm" | "md" | "lg";

export interface VisualFlowNode {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone?: VisualTone;
  readonly shape?: "box" | "pill" | "diamond";
}

export interface VisualEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface VisualSequenceMessage extends VisualEdge {
  readonly kind?: "call" | "reply" | "note";
}

export interface VisualSeries {
  readonly name: string;
  readonly values: readonly number[];
}

export type VisualNode =
  | {
      readonly type: "stack";
      readonly direction?: "vertical" | "horizontal";
      readonly gap?: VisualGap;
      readonly align?: "start" | "center" | "end" | "stretch";
      readonly children: readonly VisualNode[];
    }
  | {
      readonly type: "grid";
      readonly columns: number;
      readonly gap?: VisualGap;
      readonly children: readonly VisualNode[];
    }
  | {
      readonly type: "card";
      readonly title?: string;
      readonly subtitle?: string;
      readonly tone?: VisualTone;
      readonly children?: readonly VisualNode[];
    }
  | { readonly type: "heading"; readonly text: string; readonly level?: 1 | 2 | 3 }
  | { readonly type: "text"; readonly text: string; readonly variant?: "body" | "muted" | "small" | "strong" }
  | { readonly type: "code"; readonly text: string; readonly label?: string }
  | {
      readonly type: "list";
      readonly items: readonly (
        | string
        | {
            readonly label: string;
            readonly detail?: string;
            readonly value?: string;
            readonly tone?: VisualTone;
          }
      )[];
      readonly ordered?: boolean;
    }
  | { readonly type: "badge"; readonly text: string; readonly tone?: VisualTone }
  | {
      readonly type: "stat";
      readonly label: string;
      readonly value: string;
      readonly detail?: string;
      readonly tone?: VisualTone;
    }
  | { readonly type: "callout"; readonly tone?: VisualTone; readonly title?: string; readonly text: string }
  | {
      readonly type: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly caption?: string;
    }
  | { readonly type: "divider" }
  | {
      readonly type: "button";
      readonly label: string;
      readonly variant?: "primary" | "secondary" | "ghost";
      readonly actions: readonly VisualAction[];
    }
  | { readonly type: "reset"; readonly label?: string }
  | {
      readonly type: "tabs";
      readonly state_key: string;
      readonly label?: string;
      readonly tabs: readonly VisualPanel[];
    }
  | {
      readonly type: "segmented";
      readonly state_key: string;
      readonly label: string;
      readonly options: readonly (string | VisualOption)[];
    }
  | { readonly type: "toggle"; readonly state_key: string; readonly label: string }
  | {
      readonly type: "stepper";
      readonly state_key: string;
      readonly label?: string;
      readonly steps: readonly VisualStep[];
    }
  | {
      readonly type: "when";
      readonly state_key: string;
      readonly equals: VisualStateValue | readonly VisualStateValue[];
      readonly children: readonly VisualNode[];
    }
  | {
      readonly type: "before_after";
      readonly before: { readonly label?: string; readonly children: readonly VisualNode[] };
      readonly after: { readonly label?: string; readonly children: readonly VisualNode[] };
    }
  | {
      readonly type: "artboards";
      readonly state_key: string;
      readonly label?: string;
      readonly artboards: readonly (VisualPanel & { readonly device?: VisualDevice })[];
    }
  | {
      readonly type: "device_frame";
      readonly device: VisualDevice;
      readonly label?: string;
      readonly children: readonly VisualNode[];
    }
  | {
      readonly type: "button_preview";
      readonly label: string;
      readonly variant?: ButtonVariant;
      readonly variant_from?: string;
      readonly size?: ButtonSize;
      readonly size_from?: string;
      readonly disabled?: boolean;
      readonly disabled_from?: string;
      readonly loading?: boolean;
      readonly loading_from?: string;
    }
  | {
      readonly type: "flow";
      readonly direction?: "horizontal" | "vertical";
      readonly label?: string;
      readonly nodes: readonly VisualFlowNode[];
      readonly edges: readonly VisualEdge[];
      readonly highlight_from?: string;
    }
  | {
      readonly type: "sequence";
      readonly label?: string;
      readonly participants: readonly { readonly id: string; readonly label: string }[];
      readonly messages: readonly VisualSequenceMessage[];
      readonly step_from?: string;
    }
  | {
      readonly type: "chart";
      readonly kind: "bar" | "line";
      readonly label: string;
      readonly categories: readonly string[];
      readonly series: readonly VisualSeries[];
      readonly unit?: string;
    };

export type VisualNodeType = VisualNode["type"];

export interface VisualSpec {
  readonly schema_version: 1;
  readonly state?: { readonly [key: string]: VisualStateValue };
  readonly root: VisualNode;
}

/** Allowed values per state key, derived from the controls and actions that use it (see semantics.ts). */
export type VisualStateDomain =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "boolean" }
  | { readonly kind: "number"; readonly min: number; readonly max: number };

export type VisualState = { readonly [key: string]: VisualStateValue };
