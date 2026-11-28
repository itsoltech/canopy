// The package's generated types cover the C API. Its JavaScript entry also exposes these image handles.
declare module "libheif-js" {
  interface HeifImage {
    is_primary(): boolean;
    get_width(): number;
    get_height(): number;
    display(pixels: ImageData, done: (result: ImageData | null) => void): void;
  }

  const libheif: {
    HeifDecoder: new () => { decode(source: Uint8Array): HeifImage[] };
  };

  export default libheif;
}
