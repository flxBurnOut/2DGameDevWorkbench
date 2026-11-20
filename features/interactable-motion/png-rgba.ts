/**
 * Exact PNG <-> RGBA8 conversion without a canvas. Canvas round trips
 * premultiply alpha and can change semi-transparent pixels, which the
 * server's outside-region protection check would then reject.
 */
export type RgbaImage = { width: number; height: number; pixels: Uint8Array };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export async function decodePng(input: ArrayBuffer | Uint8Array): Promise<RgbaImage> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error('不是 PNG 图片。');
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette: Uint8Array | null = null, transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = u32(chunk, 0); height = u32(chunk, 4); depth = chunk[8]; color = chunk[9]; interlace = chunk[12];
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') transparency = chunk;
    else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(color))
    throw new Error('只支持 8 位、非隔行的 PNG。');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]!;
  const stride = width * channels;
  const joined = new Uint8Array(data.reduce((n, c) => n + c.length, 0));
  let cursor = 0;
  for (const chunk of data) { joined.set(chunk, cursor); cursor += chunk.length; }
  const raw = await transform(joined, new DecompressionStream('deflate'));
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整。');
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = lines.subarray(y * stride, (y + 1) * stride);
    const prior = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value = source[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('PNG 行过滤器无效。');
      line[x] = value & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels, p = i * 4;
    if (color === 6) pixels.set(lines.subarray(o, o + 4), p);
    else if (color === 2) {
      pixels.set(lines.subarray(o, o + 3), p);
      const opaque = !transparency || !(lines[o] === transparency[1] && lines[o + 1] === transparency[3] && lines[o + 2] === transparency[5]);
      pixels[p + 3] = opaque ? 255 : 0;
    } else if (color === 3) {
      const index = lines[o];
      if (!palette || index * 3 + 2 >= palette.length) throw new Error('PNG 调色板无效。');
      pixels.set(palette.subarray(index * 3, index * 3 + 3), p);
      pixels[p + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else {
      pixels[p] = pixels[p + 1] = pixels[p + 2] = lines[o];
      pixels[p + 3] = color === 4 ? lines[o + 1] : transparency && lines[o] === transparency[1] ? 0 : 255;
    }
  }
  return { width, height, pixels };
}

function chunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

export async function encodePng({ width, height, pixels }: RgbaImage): Promise<Uint8Array> {
  if (pixels.length !== width * height * 4) throw new Error('RGBA 数据尺寸不符。');
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', header),
    chunk('IDAT', await transform(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
}

export function base64Bytes(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function bytesFromBase64(value: string) {
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
