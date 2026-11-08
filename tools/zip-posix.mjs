#!/usr/bin/env node
/**
 * POSIX-compliant ZIP packer.
 *
 * Why this exists:
 *   PowerShell's Compress-Archive and .NET's ZipFile.CreateFromDirectory both
 *   write backslashes as path separators inside the zip on Windows.
 *   Linux/macOS `unzip` does not treat backslash as a separator, so
 *   "src\config.mjs" lands as a single flat filename instead of src/config.mjs
 *   and a Linux deployment silently fails to update the code.
 *
 * This script builds the ZIP manually per PKWARE APPNOTE:
 *   - entry names always use forward slashes
 *   - UTF-8 flag (general purpose bit 11) so Chinese filenames work
 *   - CRC32 + deflate, falling back to stored when deflate grows the data
 *   - external attributes marked as unix 0644
 *
 * No ZIP64 support (output here is ~300KB).
 *
 * Usage:
 *   node zip-posix.mjs <sourceDir> <outZip> [rootName]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [sourceDir, outZip, rootName] = process.argv.slice(2);

if (!sourceDir || !outZip) {
  console.error('Usage: node zip-posix.mjs <sourceDir> <outZip> [rootName]');
  process.exit(2);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`Source dir not found: ${sourceDir}`);
  process.exit(2);
}

// ─── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ─── collect files (POSIX relative paths) ───────────────────────────────────
function collect(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(full, rel));
    else if (e.isFile()) out.push({ rel, full });
  }
  return out;
}

const files = collect(sourceDir).map(f => ({
  ...f,
  rel: rootName ? `${rootName}/${f.rel}` : f.rel,
}));

// ─── DOS date/time ──────────────────────────────────────────────────────────
const now = new Date();
const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

// ─── build zip ──────────────────────────────────────────────────────────────
const chunkList = [];
const centralList = [];
let offset = 0;

for (const f of files) {
  const raw = fs.readFileSync(f.full);

  // deflate; keep stored if it does not help
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const payload = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;

  const crc = crc32(raw);
  const nameBuf = Buffer.from(f.rel, 'utf8');   // forward slashes, UTF-8

  // local file header (30 bytes + name + payload)
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);              // version needed to extract
  local.writeUInt16LE(0x0800, 6);          // flags: UTF-8 (bit 11)
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);              // extra field length

  chunkList.push(local, nameBuf, payload);

  // central directory entry (46 bytes + name)
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0x031e, 4);             // version made by: unix (3) << 8 | 30
  cd.writeUInt16LE(20, 6);                 // version needed
  cd.writeUInt16LE(0x0800, 8);             // flags: UTF-8
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(dosTime, 12);
  cd.writeUInt16LE(dosDate, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);                 // extra length
  cd.writeUInt16LE(0, 32);                 // comment length
  cd.writeUInt16LE(0, 34);                 // disk number start
  cd.writeUInt16LE(0, 36);                 // internal attributes
  cd.writeUInt32LE(0x81a40000, 38);        // external attributes: unix 0644
  cd.writeUInt32LE(offset, 42);            // local header offset

  centralList.push(cd, nameBuf);
  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(centralList);

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);                   // disk number
end.writeUInt16LE(0, 6);                   // disk with central dir
end.writeUInt16LE(files.length, 8);        // entries on this disk
end.writeUInt16LE(files.length, 10);       // total entries
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);                  // comment length

const outBuf = Buffer.concat([...chunkList, centralBuf, end]);

const outDir = path.dirname(path.resolve(outZip));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outZip, outBuf);

console.log(`  Files: ${files.length} (POSIX paths)`);
console.log(`  Size: ${(outBuf.length / 1024).toFixed(1)} KB`);
