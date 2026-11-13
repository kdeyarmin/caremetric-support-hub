/**
 * What an MP4 file says about itself: its length (the movie header, `mvhd`) and its picture size (the video track's header, `tkhd`, in the
 * track whose handler is `vide`). Read from the file's own boxes, so an upload is checked against what it is, not what the browser claimed.
 * Returns null for anything that is not an MP4 with one readable video track.
 */
const containers = new Set(['moov', 'trak', 'mdia']);

function boxes(bytes, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(end - at)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return null;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function find(bytes, list, type) {
  return list?.find(box => box.type === type) ?? null;
}

function children(bytes, box) {
  return containers.has(box.type) ? boxes(bytes, box.start, box.end) : null;
}

/** @param {Buffer} bytes @returns {{ durationSeconds: number, width: number, height: number } | null} */
export function mp4Info(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.toString('latin1', 4, 8) !== 'ftyp') return null;
  const top = boxes(bytes, 0, bytes.length);
  const moov = find(bytes, top, 'moov');
  if (!moov) return null;
  const inside = children(bytes, moov);
  const mvhd = find(bytes, inside, 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 20) return null;
  const version = bytes[mvhd.start];
  let timescale, duration;
  if (version === 1) {
    if (mvhd.end - mvhd.start < 32) return null;
    timescale = bytes.readUInt32BE(mvhd.start + 20);
    duration = Number(bytes.readBigUInt64BE(mvhd.start + 24));
  } else {
    timescale = bytes.readUInt32BE(mvhd.start + 12);
    duration = bytes.readUInt32BE(mvhd.start + 16);
  }
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
  let size = null;
  for (const trak of (inside ?? []).filter(box => box.type === 'trak')) {
    const parts = children(bytes, trak);
    const mdia = find(bytes, parts, 'mdia');
    const hdlr = mdia ? find(bytes, children(bytes, mdia), 'hdlr') : null;
    if (!hdlr || hdlr.end - hdlr.start < 12 || bytes.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const tkhd = find(bytes, parts, 'tkhd');
    if (!tkhd) continue;
    const offset = bytes[tkhd.start] === 1 ? 88 : 76;
    if (tkhd.end - tkhd.start < offset + 8) continue;
    const width = Math.round(bytes.readUInt32BE(tkhd.start + offset) / 65536);
    const height = Math.round(bytes.readUInt32BE(tkhd.start + offset + 4) / 65536);
    if (width > 0 && height > 0) { size = { width, height }; break; }
  }
  if (!size) return null;
  return { durationSeconds: Math.round((duration / timescale) * 100) / 100, ...size };
}
