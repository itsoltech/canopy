// Bun imports .sql files as text via `with { type: "text" }`.
declare module "*.sql" {
  const content: string;
  export default content;
}
