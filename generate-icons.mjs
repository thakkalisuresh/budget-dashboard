// Generates minimal valid PNG icons using only Node.js built-ins
import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';

function createPNG(size) {
  // Colors: indigo background #4f46e5, white wallet
  const bg  = [0x4f, 0x46, 0xe5, 0xff]; // indigo
  const fg  = [0xff, 0xff, 0xff, 0xff]; // white
  const acc = [0x38, 0x31, 0xb0, 0xff]; // darker indigo for detail

  const pixels = new Uint8Array(size * size * 4);

  // Helper: fill a rectangle
  const rect = (x1, y1, x2, y2, color) => {
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) {
        const i = (y * size + x) * 4;
        pixels[i]   = color[0];
        pixels[i+1] = color[1];
        pixels[i+2] = color[2];
        pixels[i+3] = color[3];
      }
  };

  const circle = (cx, cy, r, color) => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x-cx)**2 + (y-cy)**2 <= r**2 && x >= 0 && x < size && y >= 0 && y < size) {
          const i = (y * size + x) * 4;
          pixels[i]   = color[0];
          pixels[i+1] = color[1];
          pixels[i+2] = color[2];
          pixels[i+3] = color[3];
        }
      }
  };

  const s = size / 512; // scale factor

  // Background
  rect(0, 0, size, size, bg);

  // Wallet body (white rounded rect — approximated as rect)
  const wx1 = Math.round(96*s), wy1 = Math.round(160*s);
  const wx2 = Math.round(416*s), wy2 = Math.round(380*s);
  rect(wx1, wy1, wx2, wy2, fg);

  // Wallet top flap
  rect(wx1, Math.round(148*s), wx2, Math.round(210*s), fg);

  // Coin area
  const cx1 = Math.round(340*s), cy1 = Math.round(230*s);
  const cx2 = Math.round(400*s), cy2 = Math.round(290*s);
  rect(cx1, cy1, cx2, cy2, [0xe0, 0xde, 0xf7, 0xff]);
  circle(Math.round(370*s), Math.round(260*s), Math.round(14*s), acc);

  // Money lines
  rect(Math.round(128*s), Math.round(300*s), Math.round(268*s), Math.round(314*s), [0xc7, 0xd2, 0xfe, 0xff]);
  rect(Math.round(128*s), Math.round(326*s), Math.round(228*s), Math.round(340*s), [0xc7, 0xd2, 0xfe, 0xff]);

  // Build raw PNG
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  const ihdr = (() => {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(size, 0);
    d.writeUInt32BE(size, 4);
    d[8] = 8; d[9] = 2; // 8-bit RGB — wait, we'll do RGBA (colortype=6)
    d[9] = 6;
    return chunk('IHDR', d);
  })();

  // Build IDAT: filter byte (0) + RGB data per row — RGBA colortype 6
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (1 + size * 4) + 1 + x * 4;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }
  const idat = chunk('IDAT', deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([t, data]));
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, t, data, c]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

writeFileSync('public/icons/icon-192.png', createPNG(192));
writeFileSync('public/icons/icon-512.png', createPNG(512));
console.log('Icons generated: public/icons/icon-192.png and icon-512.png');
