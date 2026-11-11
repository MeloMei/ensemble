const imageFormats = [
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
] as const;

export type RasterImageMime = typeof imageFormats[number][1];
const imageMimeByExtension = new Map<string, RasterImageMime>(imageFormats);

export function rasterImageMimeFromPath(path: string): RasterImageMime | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? imageMimeByExtension.get(name.slice(dot).toLowerCase()) : undefined;
}
