/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/audio/id3.mjs — قراءة وكتابة ID3v2.3 + تحليل إطارات MPEG
 * ───────────────────────────────────────────────────────────────────
 *  بلا أي تبعية خارجية (node: builtins فقط)، لأن مسار النشر (deploy.yml)
 *  لا يشغّل `npm install` إطلاقًا. نفس سبب استقلالية build-ai-artifacts.mjs.
 *
 *  لماذا موجود: مخرَج generate_speech الخام يأتي بوسوم ID3v2.4 فيها إطار
 *  TSSE واحد بتشفير UTF-8. المواصفة (_data/voice_identity.json) تشترط
 *  ID3v2.3 بسبعة إطارات بتشفير UTF-16. هذا الملف يعيد الوسم **بلا أي
 *  إعادة ترميز**: بايتات الصوت تُنقل حرفيًا كما هي.
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';

// ── ID3v2 ────────────────────────────────────────────────────────────

/** حجم الوسوم المحفوظ في الترويسة (synchsafe، 28 بت) */
function synchsafe(bytes) {
  return ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
         ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
}

function writeSynchsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

/** هل الملف يبدأ بوسوم ID3v2؟ وما حجمها الكلي (ترويسة + بيانات)؟ */
export function tagExtent(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes.toString('ascii', 0, 3) !== 'ID3') return null;
  const size = synchsafe(bytes);
  const total = 10 + size;
  return total <= bytes.length ? { major: bytes[3], revision: bytes[4], flags: bytes[5], dataSize: size, total } : null;
}

/** UTF-16LE مع BOM — التشفير (1) المشترط في كل الإطارات النصية */
export function utf16(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')]);
}

/** فك تشفير نص إطار: الترميز 1 = UTF-16 بـ BOM، 3 = UTF-8، 0 = latin1 */
export function decodeText(body) {
  if (!body || body.length === 0) return { encoding: null, text: '' };
  const encoding = body[0];
  const rest = body.subarray(1);
  if (encoding === 1) {
    if (rest.length >= 2 && rest[0] === 0xff && rest[1] === 0xfe) {
      let text = rest.subarray(2).toString('utf16le');
      while (text.length > 0 && text.charCodeAt(text.length - 1) === 0) text = text.slice(0, -1);
      return { encoding, text };
    }
    let text = rest.toString('utf16le');
    while (text.length > 0 && text.charCodeAt(text.length - 1) === 0) text = text.slice(0, -1);
    return { encoding, text };
  }
  if (encoding === 3) return { encoding, text: rest.toString('utf8').replace(/\0+$/, '') };
  if (encoding === 2) return { encoding, text: rest.subarray(2).toString('utf16be').replace(/\0+$/, '') };
  return { encoding, text: rest.toString('latin1').replace(/\0+$/, '') };
}

/** قراءة كل إطارات الوسوم بالترتيب المخزّن */
export function parseFrames(bytes) {
  const extent = tagExtent(bytes);
  if (!extent) return null;
  const end = extent.total;
  const frames = [];
  let pos = 10;
  while (pos + 10 <= end) {
    if (bytes[pos] === 0) break;                       // بداية الحشو الصفري
    const id = bytes.toString('ascii', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = extent.major >= 4
      ? ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) |
        ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f)
      : bytes.readUInt32BE(pos + 4);
    const next = pos + 10 + size;
    if (size === 0 || next > end) break;
    frames.push({ id, size, offset: pos, body: bytes.subarray(pos + 10, next) });
    pos = next;
  }
  return { extent, frames, framesEnd: pos, paddingBytes: end - pos };
}

/** نص إطار نصي عادي */
export function frameText(parsed, id) {
  const frame = parsed?.frames?.find((f) => f.id === id);
  return frame ? decodeText(frame.body).text : null;
}

/** تفكيك إطار COMM: encoding(1) + language(3) + وصف UTF-16 منتهٍ بصفر + نص */
export function parseComm(frame) {
  if (!frame || frame.id !== 'COMM') return null;
  const body = frame.body;
  if (body.length < 12 || body[0] !== 1) return null;
  const language = body.toString('ascii', 1, 4);
  if (body[4] !== 0xff || body[5] !== 0xfe) return null;
  let pos = 6;
  while (pos + 1 < body.length && !(body[pos] === 0 && body[pos + 1] === 0)) pos += 2;
  if (pos + 1 >= body.length) return null;
  const description = decodeText(Buffer.concat([Buffer.from([1]), body.subarray(4, pos)])).text;
  const text = decodeText(Buffer.concat([Buffer.from([1]), body.subarray(pos + 2)])).text;
  return { language, description, text };
}

/** إطار نصي: encoding(1)=1 ثم UTF-16 بـ BOM */
function textFrame(id, value) {
  const body = Buffer.concat([Buffer.from([1]), utf16(value)]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** إطار COMM: encoding(1)=1 + لغة(3) + وصف UTF-16 + صفر مزدوج + نص UTF-16 */
function commFrame(language, description, text) {
  const body = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(language.slice(0, 3).padEnd(3, ' '), 'ascii'),
    utf16(description), Buffer.from([0, 0]), utf16(text),
  ]);
  const head = Buffer.alloc(10);
  head.write('COMM', 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * بناء وسوم ID3v2.3 كاملة من قائمة إطارات مرتّبة.
 * @param {Array<{id:string,text?:string,comm?:{language:string,description:string,text:string}}>} frames
 */
export function buildTag(frames, paddingBytes = 1024) {
  const parts = [];
  for (const frame of frames) {
    if (frame.id === 'COMM') {
      parts.push(commFrame(frame.comm.language, frame.comm.description, frame.comm.text));
    } else {
      parts.push(textFrame(frame.id, frame.text));
    }
  }
  const data = Buffer.concat([...parts, Buffer.alloc(paddingBytes)]);
  const head = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), writeSynchsafe(data.length)]);
  return Buffer.concat([head, data]);
}

/**
 * إعادة وسم ملف MP3 بلا إعادة ترميز: تُحذف الوسوم القديمة وتُكتب الجديدة،
 * وبايتات الصوت (MPEG frames) تُنسخ حرفيًا.
 * @returns {{before:number, after:number, audioBytes:number, audioIdentical:boolean}}
 */
export function retag(filePath, frames, paddingBytes = 1024) {
  const original = fs.readFileSync(filePath);
  const extent = tagExtent(original);
  const audio = extent ? original.subarray(extent.total) : original;
  const tag = buildTag(frames, paddingBytes);
  fs.writeFileSync(filePath, Buffer.concat([tag, audio]));
  const check = fs.readFileSync(filePath);
  const checkExtent = tagExtent(check);
  return {
    before: original.length,
    after: check.length,
    audioBytes: audio.length,
    audioIdentical: check.subarray(checkExtent.total).equals(audio),
  };
}

// ── إطارات MPEG الصوتية (لتحقّق المواصفة بلا ffmpeg) ─────────────────

const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
const MODES = ['stereo', 'joint_stereo', 'dual_channel', 'mono'];

function headerAt(bytes, i) {
  if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) return null;
  const b1 = bytes[i + 1]; const b2 = bytes[i + 2]; const b3 = bytes[i + 3];
  const versionBits = (b1 >> 3) & 0x03;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 2.5 : null;
  if (version === null) return null;
  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits !== 1) return null;                       // 1 = Layer III فقط
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const padding = (b2 >> 1) & 0x01;
  const mode = (b3 >> 6) & 0x03;
  const bitrate = (version === 1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
  const sampleRate = RATES[version][rateIndex];
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding;
  if (frameLength <= 0) return null;
  return { version, layer: 3, bitrate, sampleRate, samplesPerFrame, frameLength, mode: MODES[mode], channels: mode === 3 ? 1 : 2, padding };
}

/**
 * مسح كل إطارات MPEG: يعيد المدة الحقيقية ومعدّل البت ومعدّل العينة والقنوات.
 * يتجاهل أي ترويسة Xing/Info/VBRI لأنها إطار أول بصفر بايتات صوتية.
 */
export function scanMpeg(bytes) {
  const extent = tagExtent(bytes);
  let pos = extent ? extent.total : 0;
  const end = bytes.length;
  let first = null; let count = 0; let audioBytes = 0; let xing = false;
  while (pos + 4 <= end) {
    const h = headerAt(bytes, pos);
    if (!h) { pos += 1; continue; }
    if (pos + h.frameLength > end) break;
    // إطار Xing/Info/VBRI يحمل بيانات VBR ولا يحمل صوتًا: ترويسته قد تعلن
    // معدل بت مختلفًا عن الإطارات الحقيقية (رُصد 64k في إطار Xing مقابل 32k
    // في كل الإطارات الصوتية). لذلك لا يُتخذ منه المرجع ولا يُحسب في المدة.
    const body = bytes.subarray(pos, Math.min(pos + h.frameLength, end));
    const isInfo = body.includes(Buffer.from('Xing')) || body.includes(Buffer.from('Info'))
      || body.includes(Buffer.from('VBRI'));
    if (isInfo && !first) {
      xing = true;
      audioBytes += h.frameLength;
      pos += h.frameLength;
      continue;
    }
    if (!first) first = h;
    count += 1;
    audioBytes += h.frameLength;
    pos += h.frameLength;
  }
  if (!first) return null;
  return {
    mpegVersion: first.version === 1 ? 'MPEG-1' : first.version === 2 ? 'MPEG-2' : 'MPEG-2.5',
    layer: first.layer,
    bitrateBps: first.bitrate,
    sampleRateHz: first.sampleRate,
    samplesPerFrame: first.samplesPerFrame,
    channelMode: first.mode,
    channels: first.channels,
    frameCount: count,
    hasXingHeader: xing,
    durationSeconds: (count * first.samplesPerFrame) / first.sampleRate,
    audioBytes,
    trailingBytes: end - (extent ? extent.total : 0) - audioBytes,
  };
}
