// Generates resources/icon.png: a 32x32 rounded dot in the AGR green on a
// transparent background. Placeholder until real branding; committed so the
// tray always has a visible icon without any build-time dependency.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const S = 32;
const GREEN = [29, 111, 92, 255]; // #1d6f5c
const rows = [];
for (let y = 0; y < S; y++) {
  const row = Buffer.alloc(1 + S * 4); // filter byte + RGBA
  row[0] = 0;
  for (let x = 0; x < S; x++) {
    const dx = x - (S - 1) / 2;
    const dy = y - (S - 1) / 2;
    const inside = Math.sqrt(dx * dx + dy * dy) <= S / 2 - 2;
    const px = inside ? GREEN : [0, 0, 0, 0];
    px.forEach((v, i) => (row[1 + x * 4 + i] = v));
  }
  rows.push(row);
}
const raw = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", raw),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "resources", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("icon.png written:", png.length, "bytes");
