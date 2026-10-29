/*
 * Đọc file PCD (ascii, binary, binary_compressed) thành mảng x, y, z liên tiếp (Float32Array), bỏ điểm NaN / Infinity
 * như canvas của CVAT. Dùng cho frame khác frame đang mở (CVAT chỉ dựng point cloud của frame đang xem).
 */
(function (root) {
  'use strict';

  /** Giải nén LZF (binary_compressed của PCL). */
  function lzf(input, outLength) {
    const out = new Uint8Array(outLength);
    let i = 0, o = 0;
    while (i < input.length) {
      let ctrl = input[i++];
      if (ctrl < 32) {
        ctrl += 1;
        if (o + ctrl > outLength || i + ctrl > input.length) throw new Error('PCD: dữ liệu LZF hỏng');
        out.set(input.subarray(i, i + ctrl), o);
        i += ctrl; o += ctrl;
      } else {
        let len = ctrl >> 5;
        let ref = o - ((ctrl & 0x1f) << 8) - 1;
        if (len === 7) len += input[i++];
        ref -= input[i++];
        len += 2;
        if (ref < 0 || o + len > outLength) throw new Error('PCD: dữ liệu LZF hỏng');
        for (let k = 0; k < len; k += 1) out[o++] = out[ref++];
      }
    }
    return out;
  }

  function header(bytes) {
    const h = {};
    let p = 0;
    while (p < bytes.length) {
      let end = p;
      while (end < bytes.length && bytes[end] !== 10) end += 1;
      if (end >= bytes.length) throw new Error('PCD: thiếu header');
      const line = String.fromCharCode(...bytes.subarray(p, end)).trim();
      p = end + 1;
      if (!line || line.startsWith('#')) continue;
      const [key, ...rest] = line.split(/\s+/);
      h[key.toUpperCase()] = rest;
      if (key.toUpperCase() === 'DATA') break;
    }
    const fields = h.FIELDS || [];
    const size = (h.SIZE || []).map(Number), type = h.TYPE || [], count = (h.COUNT || fields.map(() => '1')).map(Number);
    const points = Number(h.POINTS?.[0] ?? (Number(h.WIDTH?.[0]) * Number(h.HEIGHT?.[0] || 1)));
    if (!fields.length || size.length !== fields.length || !Number.isInteger(points)) throw new Error('PCD: header không hợp lệ');
    return { fields, size, type, count, points, data: (h.DATA?.[0] || '').toLowerCase(), offset: p };
  }

  function reader(type, size) {
    if (type === 'F' && size === 4) return (v, o) => v.getFloat32(o, true);
    if (type === 'F' && size === 8) return (v, o) => v.getFloat64(o, true);
    if (type === 'I') return { 1: (v, o) => v.getInt8(o), 2: (v, o) => v.getInt16(o, true), 4: (v, o) => v.getInt32(o, true) }[size];
    if (type === 'U') return { 1: (v, o) => v.getUint8(o), 2: (v, o) => v.getUint16(o, true), 4: (v, o) => v.getUint32(o, true) }[size];
    return null;
  }

  /** `buffer`: ArrayBuffer hoặc Uint8Array của cả file. */
  function parse(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const h = header(bytes);
    const idx = ['x', 'y', 'z'].map((f) => h.fields.indexOf(f));
    if (idx.some((i) => i < 0)) throw new Error('PCD: thiếu trường x / y / z');
    const out = new Float32Array(h.points * 3);
    let n = 0;
    const push = (x, y, z) => {
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) { out[n++] = x; out[n++] = y; out[n++] = z; }
    };

    if (h.data === 'ascii') {
      const text = new TextDecoder('latin1').decode(bytes.subarray(h.offset));
      // Vị trí cột của từng trường khi có trường COUNT > 1.
      const col = [];
      let c = 0;
      h.fields.forEach((_, i) => { col.push(c); c += h.count[i]; });
      for (const line of text.split('\n')) {
        const v = line.trim().split(/\s+/);
        if (v.length < c) continue;
        push(Number(v[col[idx[0]]]), Number(v[col[idx[1]]]), Number(v[col[idx[2]]]));
      }
      return out.subarray(0, n);
    }
    const read = idx.map((i) => reader(h.type[i], h.size[i]));
    if (read.some((r) => !r)) throw new Error('PCD: kiểu dữ liệu x / y / z chưa hỗ trợ');
    if (h.data === 'binary') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const stride = h.size.reduce((s, sz, i) => s + sz * h.count[i], 0);
      const offs = idx.map((i) => h.size.slice(0, i).reduce((s, sz, k) => s + sz * h.count[k], 0));
      const total = Math.min(h.points, Math.floor((bytes.length - h.offset) / stride));
      for (let p = 0, o = h.offset; p < total; p += 1, o += stride) {
        push(read[0](view, o + offs[0]), read[1](view, o + offs[1]), read[2](view, o + offs[2]));
      }
    } else if (h.data === 'binary_compressed') {
      const head = new DataView(bytes.buffer, bytes.byteOffset + h.offset, 8);
      const compressed = head.getUint32(0, true), raw = head.getUint32(4, true);
      const data = lzf(bytes.subarray(h.offset + 8, h.offset + 8 + compressed), raw);
      const view = new DataView(data.buffer);
      // Dữ liệu xếp theo cột: hết trường này tới trường khác.
      const starts = [];
      let s = 0;
      h.fields.forEach((_, i) => { starts.push(s); s += h.size[i] * h.count[i] * h.points; });
      for (let p = 0; p < h.points; p += 1) {
        push(...idx.map((i, k) => read[k](view, starts[i] + p * h.size[i] * h.count[i])));
      }
    } else {
      throw new Error(`PCD: kiểu DATA "${h.data}" chưa hỗ trợ`);
    }
    return out.subarray(0, n);
  }

  const api = { parse, lzf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapPcd = api;
})(globalThis);
