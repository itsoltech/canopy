declare module "*/notices.generated.json" {
  interface PackageNotice {
    name: string;
    version: string;
    license: string;
    files: { name: string; text: string }[];
  }

  const notices: PackageNotice[];
  export default notices;
}
