// Shared, dependency-free front-matter and ID3v2.3 checks for the property/request audio gates.
import assert from 'node:assert/strict';

export function grab(front, key) {
  const hit = new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm').exec(front);
  assert.ok(hit, `front matter lacks ${key}`);
  return hit[1];
}

export function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function tagEnd(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes.toString('ascii', 0, 3) !== 'ID3' || bytes[3] !== 3) return null;
  const length = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const end = 10 + length;
  return end <= bytes.length ? end : null;
}

export function id3Frames(bytes) {
  const end = tagEnd(bytes);
  if (end === null) return null;
  const frames = [];
  let pos = 10;
  while (pos + 10 <= end) {
    if (bytes[pos] === 0) break; // zero padding, not another frame
    const size = bytes.readUInt32BE(pos + 4);
    const next = pos + 10 + size;
    if (size === 0 || next > end) return null;
    frames.push({ id: bytes.toString('ascii', pos, pos + 4), body: bytes.subarray(pos + 10, next) });
    pos = next;
  }
  return frames;
}

function decodeUtf16(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xfe) return null;
  let text = bytes.subarray(2).toString('utf16le');
  while (text.length > 0 && text.charCodeAt(text.length - 1) === 0) text = text.slice(0, -1);
  return text;
}

export function parseTextFrame(frame) {
  if (!frame || frame.body[0] !== 1) return null;
  return decodeUtf16(frame.body.subarray(1));
}

export function parseComm(bytes) {
  const frames = id3Frames(bytes);
  const comm = frames?.find((frame) => frame.id === 'COMM');
  if (!comm) return null;
  const body = comm.body;
  // encoding(1), language(3), UTF-16 description (empty on new ads), UTF-16 text.
  // Older property batches use a non-empty description; retain their regression gate.
  if (body.length < 12 || body[0] !== 1 || body.toString('ascii', 1, 4) !== 'ara') return null;
  if (body[4] !== 0xff || body[5] !== 0xfe) return null;
  let pos = 6;
  while (pos + 1 < body.length && (body[pos] !== 0 || body[pos + 1] !== 0)) pos += 2;
  if (pos + 1 >= body.length) return null;
  return decodeUtf16(body.subarray(pos + 2));
}
