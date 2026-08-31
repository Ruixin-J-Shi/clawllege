// Minimal PNG read/write for 8-bit RGBA, using only node:zlib.
//
// Exists because this machine has no Pillow and no ImageMagick, and `sips`
// only crops from the centre — useless for lifting an off-centre detail like
// the lobster's left claw. Deliberately narrow: it handles exactly the format
// the brand artwork is in (8-bit RGBA, non-interlaced) and refuses anything else
// rather than silently mangling it.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function readPNG(path) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`${path}: not a PNG`);
  let off = 8, ihdr = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colour = ihdr[9], interlace = ihdr[12];
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${path}: expected 8-bit RGBA non-interlaced, got depth=${depth} colour=${colour} interlace=${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

export function encodePNG({ width, height, data }) {
  const stride = width * 4, bpp = 4;

  // Two encodings, keep whichever deflates smaller.
  //
  // The per-scanline minimum-sum heuristic (what libpng does) is the textbook
  // choice, and on this artwork it made files ~9% BIGGER: the images are mostly
  // long runs of identical transparent pixels, which zlib already compresses
  // superbly, and filtering shreds those runs. Rather than guess, measure.
  const flat = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    flat[y * (stride + 1)] = 0;
    data.copy(flat, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const filtered = Buffer.alloc(height * (stride + 1));
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity, bestBuf = null;
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= bpp ? prev[x - bpp] : 0;
        let v;
        if (f === 0) v = cur[x];
        else if (f === 1) v = cur[x] - a;
        else if (f === 2) v = cur[x] - b;
        else if (f === 3) v = cur[x] - ((a + b) >> 1);
        else {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 0xff;
        line[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; bestBuf = Buffer.from(line); }
    }
    filtered[y * (stride + 1)] = best;
    bestBuf.copy(filtered, y * (stride + 1) + 1);
  }

  const a = zlib.deflateSync(flat, { level: 9 });
  const b = zlib.deflateSync(filtered, { level: 9 });
  const idat = a.length <= b.length ? a : b;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writePNG(path, img) {
  writeFileSync(path, encodePNG(img));
}

/**
 * Pack PNG payloads into an .ico.
 *
 * Needed because `src/app/favicon.ico` was still create-next-app's default: many
 * browsers (and Safari, which has no SVG-favicon support) prefer the .ico, so
 * shipping only icon.svg would have left the Next.js logo in the tab.
 */
export function encodeICO(images) {
  const pngs = images.map((img) => encodePNG(img));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.width >= 256 ? 0 : img.width;
    dir[o + 1] = img.height >= 256 ? 0 : img.height;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(pngs[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

export function crop(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    img.data.copy(out, row * w * 4, ((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4);
  }
  return { width: w, height: h, data: out };
}

/** Box filter downscale — good enough for stipple art and dependency-free. */
export function resize(img, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        const al = img.data[i + 3];
        r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
        a += al; n++;
      }
      const i = (y * w + x) * 4;
      out[i] = a ? r / a : 0; out[i + 1] = a ? g / a : 0; out[i + 2] = a ? b / a : 0;
      out[i + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

/** Tight bounding box of pixels with alpha above a threshold. */
export function alphaBounds(img, threshold = 8) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
