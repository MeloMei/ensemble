import { Buffer } from 'node:buffer';
import type { RasterImageMime } from '../shared/raster-image';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function detectRasterImageMime(data: Buffer): RasterImageMime | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(pngSignature) && data.subarray(12, 16).toString() === 'IHDR') return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
