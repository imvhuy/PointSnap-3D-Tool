'use strict';
/*
 * Đọc file zip trong bộ nhớ (gói frame CVAT trả về: các file .pcd, thường không nén). Chỉ cần đọc, không cần ghi,
 * nên không thêm thư viện: đọc central directory, giải nén deflate bằng zlib của Node.
 */
const zlib = require('node:zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/** [{ name, data: Buffer }] theo thứ tự trong zip; bỏ thư mục. */
function readZip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== EOCD) eocd -= 1;
  if (eocd < 0) throw new Error('Không phải file zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(p) !== CENTRAL) throw new Error('Zip hỏng: central directory');
    const method = buffer.readUInt16LE(p + 10), size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(local) !== LOCAL) throw new Error(`Zip hỏng: ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`Zip: kiểu nén ${method} chưa hỗ trợ (${name})`);
  }
  return out;
}

module.exports = { readZip };
