/**
 * Recognition subprocess for the DSH local Whisper provider.
 *
 * The parent sends one complete 16 kHz mono PCM16 WAV per request and receives
 * the recognized text with measured durations. Recognizers are cached per
 * model and language hint, because sherpa-onnx fixes the language when a
 * Whisper recognizer is created.
 * @module dsh-whisper-ru/worker
 */
import { join } from 'node:path'
import sherpa from 'sherpa-onnx-node'

/** The sample rate the Host records and the model expects. */
const SAMPLE_RATE = 16_000

/** One cached recognizer and the key it was built for. */
let cached = null

/**
 * Parse a canonical 16 kHz mono PCM16 WAV without copying it into the V8 cage.
 * @param {Buffer} buffer - the recording as sent by the parent.
 * @returns {{ samples: Float32Array, audioSeconds: number }} decoded audio.
 */
function decodeWave(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('the recording is not a RIFF/WAVE file')
  }
  let format
  let data
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length))
      break
    }
    offset = body + size + (size % 2)
  }
  if (format === undefined || data === undefined) throw new Error('the recording has no fmt or data chunk')
  if (format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== SAMPLE_RATE) {
    throw new Error(`expected 16 kHz mono PCM16 audio, got ${format.sampleRate} Hz, ${format.channels} channel(s), ${format.bits}-bit encoding ${format.encoding}`)
  }
  const samples = new Float32Array(Math.floor(data.length / 2))
  for (let index = 0; index < samples.length; index += 1) samples[index] = data.readInt16LE(index * 2) / 32768
  return { samples, audioSeconds: samples.length / SAMPLE_RATE }
}

/**
 * Reuse or create the recognizer for one model and language hint.
 * @param {{ dir: string, prefix: string, threads: number }} model - resolved model files.
 * @param {string} language - a whisper language code, or `auto`.
 * @returns {import('sherpa-onnx-node').OfflineRecognizer} the recognizer.
 */
function recognizerFor(model, language) {
  const key = `${model.dir}|${model.prefix}|${model.threads}|${language}`
  if (cached?.key === key) return cached.recognizer
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      tokens: join(model.dir, `${model.prefix}-tokens.txt`),
      whisper: {
        encoder: join(model.dir, `${model.prefix}-encoder.int8.onnx`),
        decoder: join(model.dir, `${model.prefix}-decoder.int8.onnx`),
        tokens: join(model.dir, `${model.prefix}-tokens.txt`),
        language: language === 'auto' ? '' : language,
        task: 'transcribe',
      },
      numThreads: model.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  })
  cached = { key, recognizer }
  return recognizer
}

/**
 * Recognize one recording and answer the parent request.
 * @param {Record<string, unknown>} message - the parent's transcribe request.
 */
function transcribe(message) {
  const model = message.model
  if (model === null || typeof model !== 'object') throw new Error('the request carries no model paths')
  const language = typeof message.language === 'string' ? message.language : 'auto'
  const audio = Buffer.from(String(message.audio ?? ''), 'base64')
  const { samples, audioSeconds } = decodeWave(audio)
  if (samples.length === 0) throw new Error('the recording is empty')
  const recognizer = recognizerFor(model, language)
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
  const started = Date.now()
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  const inferenceSeconds = (Date.now() - started) / 1000
  return {
    type: 'result',
    id: message.id,
    text: typeof result.text === 'string' ? result.text.trim() : '',
    audioSeconds,
    inferenceSeconds,
  }
}

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return
  if (message.type === 'shutdown') {
    process.disconnect()
    process.exit(0)
  }
  if (message.type !== 'transcribe') return
  try {
    process.send(transcribe(message))
  } catch (error) {
    process.send({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

process.on('disconnect', () => { process.exit(0) })
