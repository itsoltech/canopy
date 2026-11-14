import type { VisualNode, VisualSpec } from "../src/visuals/types.ts";

const phone: VisualNode = {
  type: "device_frame",
  device: "phone",
  children: [
    { type: "heading", text: "Cześć, Anna", level: 2 },
    { type: "stat", label: "Saldo", value: "8 240,50 zł", detail: "Konto główne" },
    {
      type: "grid",
      columns: 2,
      children: [
        { type: "button_preview", label: "Przelew" },
        { type: "button_preview", label: "BLIK", variant: "outline" },
      ],
    },
    { type: "divider" },
    { type: "text", text: "Ostatnie transakcje", variant: "muted" },
    {
      type: "list",
      items: [
        { label: "Biedronka", value: "−84,20 zł", tone: "danger" },
        { label: "Wypłata", value: "+6 500,00 zł", tone: "success" },
        { label: "Spotify", value: "−23,99 zł", tone: "danger" },
      ],
    },
  ],
};

/** The reported composition. Polish content is fixture data from the screenshot, not product copy. */
export const banking: VisualSpec = {
  schema_version: 1,
  state: { screen: "home", login: 0 },
  root: {
    type: "grid",
    columns: 2,
    children: [
      {
        type: "stack",
        children: [
          { type: "heading", text: "Mockup aplikacji", level: 2 },
          {
            type: "tabs",
            state_key: "screen",
            tabs: [
              { value: "home", label: "Start", children: [phone] },
              {
                value: "transfer",
                label: "Przelew",
                children: [{ type: "callout", title: "Review transfer", text: "250,00 zł to Anna." }],
              },
              { value: "done", label: "Gotowe", children: [{ type: "badge", tone: "success", text: "Transfer sent" }] },
            ],
          },
        ],
      },
      {
        type: "stack",
        children: [
          { type: "heading", text: "Sekwencja logowania", level: 2 },
          { type: "text", text: "Klikaj „Dalej”, żeby przejść przez kolejne kroki." },
          {
            type: "sequence",
            step_from: "login",
            participants: [
              { id: "app", label: "Aplikacja" },
              { id: "api", label: "API" },
              { id: "db", label: "Baza" },
            ],
            messages: [
              { from: "app", to: "api", label: "POST /login" },
              { from: "api", to: "db", label: "SELECT user" },
              { from: "db", to: "api", label: "hash hasła", kind: "reply" },
              { from: "api", to: "api", label: "weryfikacja bcrypt", kind: "note" },
              { from: "api", to: "app", label: "200 + JWT", kind: "reply" },
            ],
          },
          {
            type: "stack",
            direction: "horizontal",
            gap: "sm",
            children: [
              { type: "button", label: "Wstecz", actions: [{ action: "previous", state_key: "login" }] },
              { type: "button", label: "Dalej", variant: "primary", actions: [{ action: "next", state_key: "login" }] },
              { type: "reset", label: "Od nowa" },
            ],
          },
        ],
      },
    ],
  },
};
