import type { VisualNode, VisualSpec } from "../src/visuals/types.ts";

const balance: VisualNode = {
  type: "stat",
  label: "Available balance",
  value: "12 480,50 zł",
  detail: "Personal account",
};

const transactions: VisualNode = {
  type: "list",
  items: [
    { label: "Coffee House", detail: "Today · Card payment", value: "−18,50 zł", tone: "danger" },
    { label: "Salary", detail: "Yesterday · Incoming transfer", value: "+8 500,00 zł", tone: "success" },
    {
      label: "A very long merchant name for a monthly subscription",
      detail: "12 Nov · Card payment",
      value: "−49,99 zł",
    },
  ],
};

const home: readonly VisualNode[] = [
  { type: "heading", text: "Good morning, Alex", level: 2 },
  balance,
  {
    type: "stack",
    direction: "horizontal",
    children: [
      { type: "button_preview", label: "Przelew" },
      { type: "button_preview", label: "BLIK", variant: "secondary" },
    ],
  },
  { type: "card", title: "Recent transactions", children: [transactions] },
];

export const catalogue: VisualSpec = {
  schema_version: 1,
  state: { variant: "primary", size: "md", disabled: false, loading: false, step: 0, board: "desktop" },
  root: {
    type: "stack",
    children: [
      { type: "heading", text: "Workspace overview", level: 1 },
      { type: "text", text: "A compact report with clear actions and readable data." },
      {
        type: "grid",
        columns: 3,
        children: [
          { type: "stat", label: "Active threads", value: "24", detail: "+6 this week", tone: "accent" },
          { type: "stat", label: "Completed", value: "128", tone: "success" },
          { type: "stat", label: "Needs review", value: "3", tone: "warning" },
        ],
      },
      { type: "card", title: "Activity", subtitle: "Latest changes across your projects.", children: [transactions] },
      {
        type: "stack",
        direction: "horizontal",
        children: (["neutral", "accent", "info", "success", "warning", "danger"] as const).map((tone): VisualNode => ({
          type: "badge",
          text: tone,
          tone,
        })),
      },
      {
        type: "callout",
        title: "Review ready",
        tone: "success",
        text: "All checks passed. Review the changes before merging.",
      },
      {
        type: "table",
        caption: "Project activity",
        columns: ["Project", "Branch", "Status"],
        rows: [
          ["Canopy", "dev", "Ready"],
          ["A project with a longer name", "feat/improve-visual-compositions", "In progress"],
        ],
      },
      {
        type: "card",
        title: "Button playground",
        children: [
          {
            type: "segmented",
            label: "Variant",
            state_key: "variant",
            options: ["primary", "secondary", "outline", "ghost", "danger"],
          },
          { type: "segmented", label: "Size", state_key: "size", options: ["sm", "md", "lg"] },
          {
            type: "stack",
            direction: "horizontal",
            children: [
              { type: "toggle", state_key: "disabled", label: "Disable preview" },
              { type: "toggle", state_key: "loading", label: "Show loading" },
            ],
          },
          {
            type: "button_preview",
            label: "Create thread",
            variant_from: "variant",
            size_from: "size",
            disabled_from: "disabled",
            loading_from: "loading",
          },
          {
            type: "when",
            state_key: "loading",
            equals: true,
            children: [{ type: "text", variant: "small", text: "Loading preview is active." }],
          },
          { type: "reset" },
        ],
      },
      {
        type: "stepper",
        state_key: "step",
        steps: [
          { title: "Prepare", description: "Choose the project to work on." },
          {
            title: "Review a longer step title",
            children: [{ type: "list", ordered: true, items: ["Check the changes", "Read the summary"] }],
          },
          { title: "Finish", children: [{ type: "text", variant: "strong", text: "Ready to continue." }] },
        ],
      },
      {
        type: "flow",
        label: "Review flow",
        highlight_from: "step",
        nodes: [
          { id: "prepare", label: "Prepare", detail: "Select a project", shape: "pill" },
          { id: "review", label: "Review", detail: "Check the changes", shape: "diamond" },
          { id: "finish", label: "Finish", tone: "success" },
        ],
        edges: [
          { from: "prepare", to: "review", label: "Submit" },
          { from: "review", to: "finish", label: "Approve" },
        ],
      },
      {
        type: "before_after",
        before: { children: [{ type: "list", items: ["Coffee House · −18,50 zł", "Salary · +8 500,00 zł"] }] },
        after: { children: [transactions] },
      },
      {
        type: "artboards",
        state_key: "board",
        artboards: [
          { value: "desktop", label: "Desktop", device: "desktop", children: home },
          { value: "phone", label: "Phone", device: "phone", children: home },
          { value: "tablet", label: "Tablet", device: "tablet", children: home },
          { value: "browser", label: "Browser", device: "browser", children: home },
        ],
      },
      ...(["bar", "line"] as const).map((kind): VisualNode => ({
        type: "chart",
        kind,
        label: "Weekly activity",
        categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        series: [
          { name: "Completed", values: [8, 12, 9, 18, 15] },
          { name: "Opened", values: [12, 14, 8, 16, 19] },
        ],
      })),
      { type: "divider" },
      { type: "code", label: "Export format", text: '{ "schema_version": 1 }' },
      { type: "text", variant: "muted", text: "Preview data stays inside this visual." },
    ],
  },
};
