// dsh-tts output container verification.
//
// The plugin never repairs a container: the backend is responsible for a
// correct container, and this module only validates the returned bytes and
// reports what it finds. An `error` verdict means the payload is not the
// container the backend claimed (the file is kept on disk for inspection and
// the call fails); a `warning` verdict means the container is structurally
// usable but carries a known defect (e.g. the 0xFFFFFFFF / 0x7FFFFFFF
// placeholder RIFF sizes some backends emit), which strict parsers will
// misread.

/** The verification verdict for one synth output. */
export interface AudioCheck {
  /** Sample rate in Hz, when the container carries it (null for pcm or unknown formats). */
  sampleRate: number | null
  /** Duration in seconds, when it can be computed (null for pcm or unknown formats). */
  durationS: number | null
  /** Non-fatal findings (reported to the caller as warnings). */
  warnings: string[]
  /** Fatal finding (the call fails); absent when the container is acceptable. */
  error?: string
}

/** Placeholder RIFF chunk sizes emitted by some backends. */
const PLACEHOLDER_SIZES = new Set([0xffffffff, 0x7fffffff])

/**
 * Walk a RIFF/WAVE container: locate the fmt and data chunks and report their
 * declared sizes (plus the RIFF header size). The walk tolerates the
 * placeholder-size defect (a declared size of 0xFFFFFFFF / 0x7FFFFFFF is
 * recorded, and the data payload is taken to run to the end of the buffer);
 * a non-data chunk with a placeholder or out-of-buffer size breaks the chunk
 * table, and the walk stops there instead of jumping past the buffer - when
 * no data chunk was found but the fmt chunk is sound, the container is still
 * accepted and the payload is taken from the end of the walk to the buffer
 * end (a warning is reported by the caller).
 * @param buf the output bytes.
 * @returns the parsed fmt facts, the declared sizes, and the data chunk
 *   location, or null when the buffer is not a RIFF/WAVE container.
 */
function parseRiff(buf: Buffer): {
  sampleRate: number
  channels: number
  bitsPerSample: number
  riffSizeDeclared: number
  dataSizeDeclared: number
  dataOffset: number
  dataFound: boolean
} | null {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  const riffSizeDeclared = buf.readUInt32LE(4)
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataSizeDeclared = -1
  let dataOffset = -1
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'data') {
      dataSizeDeclared = size
      dataOffset = body
      break
    }
    if (id === 'fmt ') {
      if (body + 16 <= buf.length) {
        sampleRate = buf.readUInt32LE(body + 4)
        channels = buf.readUInt16LE(body + 2)
        bitsPerSample = buf.readUInt16LE(body + 14)
      }
    }
    // A placeholder (or out-of-buffer) size on a non-data chunk makes the
    // following headers unlocatable: stop the walk where it is.
    if (PLACEHOLDER_SIZES.has(size) || body + size > buf.length) break
    off = body + size + (size % 2) // RIFF chunk padding
  }
  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0) return null
  const dataFound = dataOffset >= 0
  if (!dataFound) dataOffset = off
  return { sampleRate, channels, bitsPerSample, riffSizeDeclared, dataSizeDeclared, dataOffset, dataFound }
}

/**
 * Verify one synth output against the container the backend claimed.
 * @param format the response_format the caller requested (the container claim).
 * @param buf the output bytes.
 * @returns the verdict (never throws).
 */
export function verifyAudio(format: string, buf: Buffer): AudioCheck {
  const warnings: string[] = []
  let sampleRate: number | null = null
  let durationS: number | null = null
  let error: string | undefined

  switch (format) {
    case 'wav': {
      // Split the two null reasons of parseRiff: a buffer that is not
      // RIFF/WAVE at all vs. one that is RIFF/WAVE but has no sound fmt chunk.
      const isRiff = buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
      if (!isRiff) {
        error = `output is not a RIFF/WAVE container (the backend claimed response_format "wav")`
        break
      }
      const riff = parseRiff(buf)
      if (riff === null) {
        error = `output is a RIFF/WAVE container without a valid fmt chunk (the backend claimed response_format "wav")`
        break
      }
      const sizeIssues: string[] = []
      if (PLACEHOLDER_SIZES.has(riff.riffSizeDeclared)) sizeIssues.push('the RIFF header size')
      if (PLACEHOLDER_SIZES.has(riff.dataSizeDeclared)) sizeIssues.push('the data chunk size')
      if (sizeIssues.length > 0) {
        warnings.push(
          `wav: ${sizeIssues.join(' and ')} ${sizeIssues.length > 1 ? 'are' : 'is'} placeholder RIFF size${sizeIssues.length > 1 ? 's' : ''} (0xFFFFFFFF or 0x7FFFFFFF; strict parsers will misread the duration); the payload is valid RIFF data after the header`,
        )
      }
      if (!riff.dataFound) {
        warnings.push(
          'wav: no data chunk found (the chunk table is broken, likely a placeholder chunk size); the payload is taken from the end of the last readable chunk to the end of the buffer',
        )
      }
      const bytesPerSecond = (riff.sampleRate * riff.channels * riff.bitsPerSample) / 8
      // The payload runs from the data chunk (or the end of the walk when the
      // chunk table is broken) to the end of the buffer: this holds both for
      // well-formed files and for the placeholder-size defect, where the
      // declared size is meaningless.
      const payload = buf.subarray(riff.dataOffset)
      sampleRate = riff.sampleRate
      durationS = bytesPerSecond > 0 ? payload.byteLength / bytesPerSecond : null
      break
    }
    case 'mp3': {
      const sync = buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
      const id3 = buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3'
      if (!sync && !id3) error = 'output has no MP3 frame sync or ID3 tag (the backend claimed response_format "mp3")'
      break
    }
    case 'flac': {
      if (!(buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC')) {
        error = 'output is not a FLAC stream (missing the fLaC magic, the backend claimed response_format "flac")'
      }
      break
    }
    case 'aac': {
      const adts = buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0
      if (!adts) error = 'output has no ADTS header (the backend claimed response_format "aac")'
      break
    }
    case 'opus': {
      if (!(buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS')) {
        error = 'output is not an Ogg container (missing the OggS magic, the backend claimed response_format "opus")'
      }
      break
    }
    case 'pcm': {
      // Raw samples carry no container and no rate: both stay null.
      break
    }
    default: {
      warnings.push(`no container check for response_format "${format}" (no known magic)`)
    }
  }

  return { sampleRate, durationS, warnings, ...(error !== undefined ? { error } : {}) }
}
