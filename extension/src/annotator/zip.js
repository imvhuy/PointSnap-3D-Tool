/*
 * Đọc mục lục file zip trong bộ nhớ (gói frame CVAT trả về: các file .pcd, thường không nén). Hàm thuần, không giải nén:
 * trả dữ liệu thô và kiểu nén để bên gọi tự giải (trình duyệt: DecompressionStream('deflate-raw')).
 */
(function (root) {
  'use strict';

  const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

  /** `buffer`: ArrayBuffer hoặc Uint8Array. Trả [{ name, method (0: không nén, 8: deflate), raw: Uint8Array }]; bỏ thư mục. */
  function entries(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => view.getUint16(o, true), u32 = (o) => view.getUint32(o, true);
    let eocd = bytes.length - 22;
    while (eocd >= 0 && u32(eocd) !== EOCD) eocd -= 1;
    if (eocd < 0) throw new Error('Không phải file zip');
    const count = u16(eocd + 10);
    let p = u32(eocd + 16);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      if (u32(p) !== CENTRAL) throw new Error('Zip hỏng: central directory');
      const method = u16(p + 10), size = u32(p + 20);
      const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32), local = u32(p + 42);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (u32(local) !== LOCAL) throw new Error(`Zip hỏng: ${name}`);
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      out.push({ name, method, raw: bytes.subarray(start, start + size) });
    }
    return out;
  }

  const api = { entries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapZip = api;
})(globalThis);
