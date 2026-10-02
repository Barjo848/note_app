/* wav.js — WavReader: parses a RIFF/WAVE (or RF64) header from File slices.
 *
 * Only the chunk headers and the fmt/ds64 chunks are read; the data chunk is
 * located, not loaded. The result describes how to decode the samples so the
 * worker can stream them later. */
'use strict';

class WavError extends Error {
  constructor(msg, { unsupported = false } = {}) { super(msg); this.name = 'WavError'; this.unsupported = unsupported; }
}

const WavReader = {
  FINGERPRINT_BYTES: 1024 * 1024,

  async _view(file, offset, length) {
    const end = Math.min(file.size, offset + length);
    return new DataView(await file.slice(offset, end).arrayBuffer());
  },
  _tag(dv, off) {
    if (off + 4 > dv.byteLength) return '';
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  },
  _u64(dv, off) { return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000; },

  /**
   * @param {File|Blob} file
   * @returns {Promise<WavInfo>} see fields below; throws WavError.
   */
  async parse(file) {
    if (!file || file.size < 12) throw new WavError('File is too small to be a WAV file.');
    const head = await this._view(file, 0, 12);
    const riff = this._tag(head, 0), wave = this._tag(head, 8);
    if (riff === 'RIFX') throw new WavError('Big-endian RIFX WAV files are not supported.', { unsupported: true });
    if (!(riff === 'RIFF' || riff === 'RF64') || wave !== 'WAVE') {
      throw new WavError('Not a WAV file (missing RIFF/WAVE header).', { unsupported: true });
    }
    const chunks = [];
    let fmt = null, data = null, ds64 = null, warnings = [];
    let pos = 12;
    while (pos + 8 <= file.size) {
      const h = await this._view(file, pos, 8);
      const id = this._tag(h, 0);
      let size = h.getUint32(4, true);
      const bodyStart = pos + 8;
      if (!/^[\x20-\x7e]{4}$/.test(id)) { warnings.push(`Stopped reading chunks at byte ${pos}: unreadable chunk id.`); break; }

      if (id === 'ds64' && size >= 28) {
        const dv = await this._view(file, bodyStart, Math.min(size, 28));
        ds64 = { riffSize: this._u64(dv, 0), dataSize: this._u64(dv, 8), sampleCount: this._u64(dv, 16) };
      } else if (id === 'fmt ') {
        if (size < 16) throw new WavError('Malformed WAV: fmt chunk is too short.');
        const dv = await this._view(file, bodyStart, Math.min(size, 64));
        fmt = this._parseFmt(dv, Math.min(size, dv.byteLength));
      } else if (id === 'data') {
        let dataSize = size;
        if (riff === 'RF64' && size === 0xFFFFFFFF && ds64) dataSize = ds64.dataSize;
        if (dataSize === 0 || dataSize === 0xFFFFFFFF || bodyStart + dataSize > file.size) {
          const clamped = file.size - bodyStart;
          if (dataSize !== 0 && dataSize !== 0xFFFFFFFF) warnings.push(`data chunk claims ${dataSize} bytes but only ${clamped} are present; using what is there.`);
          else warnings.push('data chunk has no size (streaming/unfinalised file); using the rest of the file.');
          dataSize = clamped;
        }
        data = { offset: bodyStart, size: dataSize };
        size = dataSize;
        chunks.push({ id, size, offset: pos });
        if (fmt) break; // fmt normally precedes data; if not, keep walking for it
        pos = bodyStart + size + (size & 1);
        continue;
      }
      chunks.push({ id, size, offset: pos });
      pos = bodyStart + size + (size & 1); // chunks are word-aligned: odd sizes carry one pad byte
    }
    if (!fmt) throw new WavError('Malformed WAV: no fmt chunk found.');
    if (!data) throw new WavError('Malformed WAV: no data chunk found.');

    const blockAlign = fmt.channels * (fmt.bitDepth / 8);
    if (fmt.blockAlign !== blockAlign) warnings.push(`Header blockAlign ${fmt.blockAlign} disagrees with channels×bytes (${blockAlign}); using ${blockAlign}.`);
    const totalFrames = Math.floor(data.size / blockAlign);
    if (totalFrames < 1) throw new WavError('WAV file contains no audio frames.');
    const durationSeconds = totalFrames / fmt.sampleRate;

    const info = {
      fileName: file.name || 'audio.wav',
      sizeBytes: file.size,
      container: riff,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitDepth: fmt.bitDepth,
      format: fmt.format,            // 'pcm' | 'float'
      blockAlign,
      dataOffset: data.offset,
      dataSize: totalFrames * blockAlign,
      totalFrames,
      durationSeconds,
      chunks,
      warnings,
      fingerprint: null,
    };
    info.fingerprint = await this.fingerprint(file, info);
    return info;
  },

  _parseFmt(dv, size) {
    const tag = dv.getUint16(0, true);
    const channels = dv.getUint16(2, true);
    const sampleRate = dv.getUint32(4, true);
    const blockAlign = dv.getUint16(12, true);
    let bitDepth = dv.getUint16(14, true);
    let formatTag = tag;
    if (tag === 0xFFFE) { // WAVE_FORMAT_EXTENSIBLE: real format lives in the sub-format GUID
      if (size < 40) throw new WavError('Malformed WAV: EXTENSIBLE fmt chunk is too short.');
      const validBits = dv.getUint16(18, true);
      formatTag = dv.getUint16(24, true);
      if (validBits && validBits < bitDepth) { /* container bits stay authoritative for decoding */ }
    }
    let format;
    if (formatTag === 1) format = 'pcm';
    else if (formatTag === 3) format = 'float';
    else throw new WavError(`Unsupported WAV encoding (format tag 0x${formatTag.toString(16)}); only PCM and IEEE float are supported.`, { unsupported: true });
    if (format === 'pcm' && ![8, 16, 24, 32].includes(bitDepth)) throw new WavError(`Unsupported PCM bit depth: ${bitDepth}.`, { unsupported: true });
    if (format === 'float' && ![32, 64].includes(bitDepth)) throw new WavError(`Unsupported float bit depth: ${bitDepth}.`, { unsupported: true });
    if (channels < 1 || channels > 32) throw new WavError(`Unsupported channel count: ${channels}.`, { unsupported: true });
    if (!(sampleRate > 0 && sampleRate < 1e7)) throw new WavError(`Unsupported sample rate: ${sampleRate}.`, { unsupported: true });
    return { channels, sampleRate, blockAlign, bitDepth, format };
  },

  /**
   * Fingerprint = SHA-256 over (first 1 MiB of the file ‖ "|<sizeBytes>|<duration to 3 dp>") as hex.
   * The size and duration make two files with identical headers but different length distinct.
   */
  async fingerprint(file, info) {
    const headBuf = new Uint8Array(await file.slice(0, Math.min(file.size, this.FINGERPRINT_BYTES)).arrayBuffer());
    const tail = new TextEncoder().encode(`|${info.sizeBytes}|${info.durationSeconds.toFixed(3)}`);
    const all = new Uint8Array(headBuf.length + tail.length);
    all.set(headBuf); all.set(tail, headBuf.length);
    return await U.sha256HexAsync(all);
  },
};
