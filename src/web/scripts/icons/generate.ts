import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates the PWA icons (public/icon-*.png, apple-touch-icon.png) without
 * any image dependencies: pixels are drawn directly and encoded as PNG by
 * hand. Rerun with `npx tsx scripts/icons/generate.ts` if the mark changes.
 *
 * The mark: the site's amber diamond ring on the app's slate background —
 * full-bleed so it also works as a maskable icon.
 */

const BG = [15, 23, 42]; // slate-900, matches --bg
const ACCENT = [245, 158, 11]; // amber, matches --accent

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgb: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // scanlines with filter byte 0
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(
      rgb.subarray(y * size * 3, (y + 1) * size * 3),
      y * (size * 3 + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Color at a point in unit space: amber diamond ring on slate. */
function colorAt(u: number, v: number): number[] {
  const dx = Math.abs(u - 0.5);
  const dy = Math.abs(v - 0.5);
  const d = dx + dy; // diamond metric
  if (d <= 0.32 && d >= 0.17) return ACCENT;
  if (d <= 0.08) return ACCENT; // center dot
  return BG;
}

function drawIcon(size: number): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  const sub = [0.25, 0.75]; // 2x2 supersampling for smooth diagonals
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const sy of sub) {
        for (const sx of sub) {
          const [cr, cg, cb] = colorAt((x + sx) / size, (y + sy) / size);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const i = (y * size + x) * 3;
      rgb[i] = r / 4;
      rgb[i + 1] = g / 4;
      rgb[i + 2] = b / 4;
    }
  }
  return rgb;
}

const PUBLIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../public",
);
for (const [file, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
] as const) {
  writeFileSync(resolve(PUBLIC_DIR, file), encodePng(size, drawIcon(size)));
  console.log(`wrote public/${file}`);
}
