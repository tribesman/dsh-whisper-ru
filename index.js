/**
 * Local Whisper speech recognition for DeepSeek Harness.
 *
 * Registers a Host-side `speechToText` provider backed by a sherpa-onnx Whisper
 * model. Model files are downloaded on demand from a Hugging Face-compatible
 * origin, verified by size and SHA-256, and reused afterwards. Recognition runs
 * in a separate Node subprocess so a long utterance never blocks the Host.
 * @module dsh-whisper-ru
 */
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Loader row name; must match the package name in `package.json`. */
export const name = 'dsh-whisper-ru'
/** The recognition registry this plugin contributes a provider to. */
export const inject = ['speechToText']

/** Minimum interval between download progress notifications. */
const PROGRESS_INTERVAL_MS = 100
/** Whisper's own tokenizer is shared by every multilingual checkpoint. */
const TOKENS_SHA256 = 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
const TOKENS_SIZE = 816730

/**
 * Pinned multilingual checkpoints published for sherpa-onnx. Every file is
 * verified against these sizes and digests before it is used.
 */
const MODELS = {
  tiny: {
    diskBytes: 103_000_000,
    files: [
      { file: 'tiny-encoder.int8.onnx', size: 12_937_772, sha256: 'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434' },
      { file: 'tiny-decoder.int8.onnx', size: 89_855_401, sha256: 'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925' },
      { file: 'tiny-tokens.txt', size: TOKENS_SIZE, sha256: TOKENS_SHA256 },
    ],
  },
  base: {
    diskBytes: 161_000_000,
    files: [
      { file: 'base-encoder.int8.onnx', size: 29_120_534, sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11' },
      { file: 'base-decoder.int8.onnx', size: 130_672_026, sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d' },
      { file: 'base-tokens.txt', size: TOKENS_SIZE, sha256: TOKENS_SHA256 },
    ],
  },
  small: {
    diskBytes: 376_000_000,
    files: [
      { file: 'small-encoder.int8.onnx', size: 112_442_483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { file: 'small-decoder.int8.onnx', size: 262_226_114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      { file: 'small-tokens.txt', size: TOKENS_SIZE, sha256: TOKENS_SHA256 },
    ],
  },
  medium: {
    diskBytes: 947_000_000,
    files: [
      { file: 'medium-encoder.int8.onnx', size: 374_196_283, sha256: '1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e' },
      { file: 'medium-decoder.int8.onnx', size: 571_059_257, sha256: '595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747' },
      { file: 'medium-tokens.txt', size: TOKENS_SIZE, sha256: TOKENS_SHA256 },
    ],
  },
}

/** Language hints offered to the voice UI; `auto` lets Whisper detect the language. */
const LANGUAGES = ['auto', 'ru', 'en', 'de', 'es', 'fr', 'pt', 'ja', 'zh', 'ko']

/** Default download origins, compared in order before the first missing asset. */
const DEFAULT_ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com']

/** One preparation step in the voice UI's expected order. */
const STEP_ORDER = ['check', 'model', 'verify']

/** A repeated download failure classified for the voice UI's localized guidance. */
class DownloadFailure extends Error {
  /**
   * @param {string} reason - one of the UI's download failure reasons.
   * @param {string} message - diagnostic text for logs and plugin details.
   * @param {number} [status] - HTTP status when the origin answered with an error.
   */
  constructor(reason, message, status) {
    super(message)
    this.name = 'DownloadFailure'
    this.reason = reason
    this.status = status
  }
}

/** The dsh home directory holding downloaded models by default. */
function dshHome() {
  const fromEnvironment = process.env.DSH_HOME
  return fromEnvironment !== undefined && fromEnvironment !== '' ? fromEnvironment : join(homedir(), '.dsh')
}

/**
 * Read and validate the row config without a schema dependency.
 * @param {unknown} config - the row's `config` object.
 * @returns the resolved settings used by preparation and recognition.
 */
function readConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const model = raw.model ?? 'small'
  if (!Object.hasOwn(MODELS, model)) throw new Error(`whisper: unknown model "${model}"; choose tiny, base, small or medium`)
  const dataRoot = raw.dataRoot ?? join(dshHome(), 'speech-to-text', 'whisper')
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot)) throw new Error(`whisper: dataRoot must be an absolute path: ${dataRoot}`)
  const modelOrigin = raw.modelOrigin
  if (modelOrigin !== undefined) new URL(modelOrigin)
  const modelOrigins = raw.modelOrigins ?? DEFAULT_ORIGINS
  if (!Array.isArray(modelOrigins) || modelOrigins.length === 0) throw new Error('whisper: modelOrigins must list at least one origin')
  for (const origin of modelOrigins) new URL(origin)
  const threads = raw.threads ?? 4
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new Error('whisper: threads must be an integer between 1 and 64')
  const providerId = raw.providerId ?? 'whisper-local'
  if (typeof providerId !== 'string' || providerId === '') throw new Error('whisper: providerId must be a non-empty string')
  const inferenceTimeoutMs = raw.inferenceTimeoutMs ?? 300_000
  if (!Number.isInteger(inferenceTimeoutMs) || inferenceTimeoutMs < 1) throw new Error('whisper: inferenceTimeoutMs must be a positive integer')
  return {
    model,
    dataRoot,
    modelDir: join(dataRoot, model),
    modelOrigin,
    modelOrigins: modelOrigins.map(origin => origin.replace(/\/+$/, '')),
    threads,
    providerId,
    inferenceTimeoutMs,
  }
}

/** The origins preparation may download from, in the configured order. */
function candidateOrigins(options) {
  return options.modelOrigin === undefined ? options.modelOrigins : [options.modelOrigin.replace(/\/+$/, '')]
}

/** The Hugging Face namespace that publishes sherpa-onnx Whisper checkpoints. */
const REPOSITORY_OWNER = 'csukuangfj'

/** The URL of one model file at an origin. */
function assetUrl(origin, options, file) {
  const repository = `${REPOSITORY_OWNER}/sherpa-onnx-whisper-${options.model}`
  return `${origin}/${repository}/resolve/main/${file}`
}

/** The pinned asset table for the configured model. */
function assetFiles(options) {
  return MODELS[options.model].files
}

/** SHA-256 of a file, streamed so a checkpoint never loads into memory twice. */
async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Whether a path exists as a regular file of the expected size. */
async function hasSize(path, size) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size === size
  } catch {
    return false
  }
}

/** Read the sidecar that records verified assets, or undefined when absent or malformed. */
async function readMarker(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Whether the recorded verification still describes the files on disk. */
async function markerIsCurrent(options, marker) {
  if (marker === undefined || marker.model !== options.model) return false
  const files = assetFiles(options)
  if (!Array.isArray(marker.files) || marker.files.length !== files.length) return false
  return await Promise.all(files.map(async file => {
    const entry = marker.files.find(candidate => candidate.file === file.file)
    return entry !== undefined && entry.size === file.size && entry.sha256 === file.sha256
      && await hasSize(join(options.modelDir, file.file), file.size)
  })).then(results => results.every(Boolean))
}

/** Download one asset with byte progress, replacing the destination only after completion. */
async function downloadAsset(url, destination, signal, onProgress) {
  let response
  try {
    response = await fetch(url, { signal, redirect: 'follow' })
  } catch (error) {
    if (signal.aborted) throw error
    throw new DownloadFailure('network', `cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok || response.body === null) {
    throw new DownloadFailure('http', `${new URL(url).host} answered HTTP ${response.status}`, response.status)
  }
  const totalBytes = Number(response.headers.get('content-length')) || undefined
  const partial = `${destination}.part`
  let received = 0
  let lastReport = 0
  const report = (completed) => {
    const now = Date.now()
    if (now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress(completed, totalBytes)
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      async function* count(source) {
        for await (const chunk of source) {
          received += chunk.length
          report(received)
          yield chunk
        }
      },
      createWriteStream(partial),
    )
    onProgress(received, totalBytes)
    await rename(partial, destination)
  } catch (error) {
    await rm(partial, { force: true })
    if (signal.aborted) throw error
    if (error instanceof DownloadFailure) throw error
    throw new DownloadFailure('storage', `cannot save ${destination}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Provider preparation: inspect, download, verify and report readiness. */
class ModelPreparation {
  #options
  #state = { phase: 'unprepared' }
  #listeners = new Set()
  #task
  #controller
  #started = false

  /** @param {ReturnType<typeof readConfig>} options - resolved settings. */
  constructor(options) {
    this.#options = options
  }

  /** @returns the latest Host-owned preparation state. */
  snapshot() {
    return this.#state
  }

  /**
   * @param {() => void} listener - state invalidation callback.
   * @returns subscription disposer.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Inspect cached resources at activation without downloading or loading models. */
  async inspect() {
    const options = this.#options
    const pending = STEP_ORDER.map(kind => ({ kind, status: 'pending' }))
    const marker = await readMarker(join(options.modelDir, '.verified.json'))
    if (this.#started) return
    if (await markerIsCurrent(options, marker)) {
      if (this.#started) return
      this.#set({ phase: 'standby', step: 'verify', steps: STEP_ORDER.map(kind => ({ kind, status: 'complete' })) })
      return
    }
    if (this.#started) return
    this.#set({ phase: 'unprepared', steps: pending })
  }

  /**
   * Start or join the current preparation task.
   * @param {{ downloadSource?: string } | undefined} [request] - task-local download source.
   */
  prepare(request) {
    if (this.#task !== undefined) return
    this.#started = true
    const source = request?.downloadSource
    if (source !== undefined && !this.#options.modelOrigins.includes(source.replace(/\/+$/, ''))) {
      throw new Error(`whisper: ${source} is not an advertised download source`)
    }
    const controller = new AbortController()
    this.#controller = controller
    this.#task = this.#run(source === undefined ? undefined : source.replace(/\/+$/, ''), controller.signal)
      .catch(error => {
        if (controller.signal.aborted) return
        this.#set(failureState(error, this.#state))
      })
      .finally(() => {
        this.#task = undefined
        this.#controller = undefined
      })
  }

  /** Cancel preparation and wait for its resources to settle. */
  async cancel() {
    const controller = this.#controller
    if (controller === undefined) return
    controller.abort()
    this.#set({ ...this.#state, phase: 'cancelling' })
    await this.#task
    this.#set({ phase: 'cancelled', step: 'check', steps: STEP_ORDER.map(kind => ({ kind, status: 'cancelled' })) })
  }

  /** @param {{ phase: string } & Record<string, unknown>} state - next published state. */
  #set(state) {
    this.#state = state
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        /* a listener's failure must not break preparation */
      }
    }
  }

  /** Build a state carrying step progress. */
  #steps(runningStep, completeSteps, phase, extra) {
    return {
      phase,
      step: runningStep,
      steps: STEP_ORDER.map(kind => ({
        kind,
        status: completeSteps.includes(kind) ? 'complete' : kind === runningStep ? 'running' : 'pending',
      })),
      ...extra,
    }
  }

  /** Download every missing asset, verify the cached ones and publish standby. */
  async #run(downloadSource, signal) {
    const options = this.#options
    this.#set(this.#steps('check', [], 'checking'))
    await mkdir(options.modelDir, { recursive: true })
    const origins = downloadSource === undefined ? candidateOrigins(options) : [downloadSource]
    const pending = []
    for (const file of assetFiles(options)) {
      const destination = join(options.modelDir, file.file)
      if (await hasSize(destination, file.size)) continue
      pending.push({ file, destination })
    }
    if (pending.length > 0) this.#set(this.#steps('model', ['check'], 'downloading', {
      resource: pending[0].file.file,
      completedBytes: 0,
      totalBytes: pending[0].file.size,
    }))
    for (const { file, destination } of pending) {
      const attempts = []
      let lastError
      for (const origin of origins) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            await downloadAsset(assetUrl(origin, options, file.file), destination, signal, (completedBytes, totalBytes) => {
              this.#set(this.#steps('model', ['check'], 'downloading', {
                resource: file.file,
                completedBytes,
                totalBytes: totalBytes ?? file.size,
                source: origin,
              }))
            })
            lastError = undefined
            break
          } catch (error) {
            if (signal.aborted) throw error
            lastError = error
            if (attempt === 2 || (error instanceof DownloadFailure && error.reason === 'http' && error.status === 404)) {
              attempts.push(`${origin}: ${error instanceof Error ? error.message : String(error)}`)
              break
            }
            await new Promise(resolve => setTimeout(resolve, 750))
          }
        }
        if (lastError === undefined) break
      }
      if (lastError !== undefined) {
        if (lastError instanceof DownloadFailure) {
          const failure = new DownloadFailure(
            lastError.reason,
            `${lastError.message}; tried ${attempts.length === 1 ? 'the only source' : `${attempts.length} sources`}: ${attempts.join(' | ')}`,
            lastError.status,
          )
          failure.source = origins[origins.length - 1]
          throw failure
        }
        throw lastError
      }
    }
    this.#set(this.#steps('verify', ['check', 'model'], 'checking'))
    for (const file of assetFiles(options)) {
      const destination = join(options.modelDir, file.file)
      if (!await hasSize(destination, file.size)) {
        throw new DownloadFailure('integrity', `${file.file} has an unexpected size`)
      }
      const digest = await fileSha256(destination)
      if (digest !== file.sha256) {
        await rm(destination, { force: true })
        throw new DownloadFailure('integrity', `${file.file} failed SHA-256 verification`)
      }
    }
    await writeFile(join(options.modelDir, '.verified.json'), `${JSON.stringify({
      model: options.model,
      files: assetFiles(options).map(({ file, size, sha256 }) => ({ file, size, sha256 })),
      verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    this.#set({ phase: 'standby', step: 'verify', steps: STEP_ORDER.map(kind => ({ kind, status: 'complete' })) })
  }
}

/** Shape a preparation failure for the voice UI, keeping download diagnostics. */
function failureState(error, previous) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof DownloadFailure) {
    return {
      phase: 'failed',
      message,
      step: previous.step ?? 'model',
      steps: previous.steps,
      download: {
        resource: previous.resource ?? 'model',
        source: error.source ?? previous.source ?? 'unknown',
        reason: error.reason,
        ...(error.status === undefined ? {} : { status: error.status }),
      },
    }
  }
  return { phase: 'failed', message, step: previous.step, steps: previous.steps }
}

/** One long-lived recognition subprocess with lazily created recognizers. */
class WhisperEngine {
  #options
  #child
  #spawned
  #pending = new Map()
  #nextId = 1
  #diagnostics = ''
  #disposed = false

  /** @param {ReturnType<typeof readConfig>} options - resolved settings. */
  constructor(options) {
    this.#options = options
  }

  /** Start the subprocess when the first recording arrives. */
  #ensureChild() {
    if (this.#child !== undefined) return this.#child
    const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))
    const child = fork(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    child.stdout?.on('data', chunk => this.#remember(chunk))
    child.stderr?.on('data', chunk => this.#remember(chunk))
    child.on('message', message => this.#onMessage(message))
    child.on('exit', (code, signal) => {
      this.#child = undefined
      this.#spawned = undefined
      const reason = `whisper worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})${this.#diagnostics === '' ? '' : `: ${this.#diagnostics}`}`
      for (const entry of [...this.#pending.values()]) entry.reject(new Error(reason))
      this.#pending.clear()
    })
    child.on('error', error => {
      for (const entry of [...this.#pending.values()]) entry.reject(error)
      this.#pending.clear()
    })
    this.#child = child
    this.#spawned = new Promise((resolve, reject) => {
      child.once('spawn', () => { resolve() })
      child.once('error', reject)
    })
    return child
  }

  /** Retain the tail of worker output for failure diagnostics. */
  #remember(chunk) {
    this.#diagnostics = `${this.#diagnostics}${chunk.toString()}`.slice(-4096)
  }

  /** Settle one pending request from a worker reply. */
  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    const entry = this.#pending.get(message.id)
    if (entry === undefined) return
    this.#pending.delete(message.id)
    if (message.type === 'result') entry.resolve(message)
    else entry.reject(new Error(message.message ?? 'whisper worker failed'))
  }

  /** Kill the subprocess; pending requests settle through its exit handler. */
  #kill() {
    const child = this.#child
    this.#child = undefined
    this.#spawned = undefined
    if (child !== undefined && child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }

  /**
   * Transcribe one complete recording.
   * @param {Uint8Array} audio - canonical 16 kHz mono PCM16 WAV bytes.
   * @param {string} language - a hint from this provider's advertised languages.
   * @param {AbortSignal} signal - caller cancellation.
   * @returns {{ text: string, audioSeconds: number, inferenceSeconds: number }}
   */
  async transcribe(audio, language, signal) {
    if (this.#disposed) throw new Error('whisper: recognizer is disposed')
    const child = this.#ensureChild()
    await this.#spawned
    if (signal.aborted) throw abortError()
    const id = this.#nextId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.#kill()
        reject(new Error(`whisper: recognition exceeded ${this.#options.inferenceTimeoutMs} ms`))
      }, this.#options.inferenceTimeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.#pending.delete(id)
        this.#kill()
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve({ text: result.text, audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds })
        },
        reject: (error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      const payload = {
        type: 'transcribe',
        id,
        language,
        audio: Buffer.from(audio).toString('base64'),
        model: { dir: this.#options.modelDir, prefix: this.#options.model, threads: this.#options.threads },
      }
      try {
        child.send(payload)
      } catch (error) {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.#pending.delete(id)
        this.#kill()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Release the subprocess and settle anything still waiting. */
  async dispose() {
    this.#disposed = true
    const child = this.#child
    this.#kill()
    for (const entry of [...this.#pending.values()]) entry.reject(new Error('whisper: recognizer was disposed'))
    this.#pending.clear()
    if (child !== undefined) await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000) })
  }
}

/** A cancellation rejection the speech service passes through to its caller. */
function abortError() {
  const error = new Error('whisper: recognition was cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * Register the Whisper provider with the Host registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context providing `speechToText`.
 * @param {unknown} config - the Loader row's `config` object.
 */
export function apply(ctx, config) {
  const options = readConfig(config)
  const preparation = new ModelPreparation(options)
  const engine = new WhisperEngine(options)
  const estimate = MODELS[options.model].diskBytes
  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: options.providerId,
        name: `Whisper ${options.model} (INT8)`,
        location: 'host-local',
        languages: LANGUAGES,
        downloadSources: candidateOrigins(options),
        setupEstimate: {
          recommendedDiskBytes: Math.ceil(estimate * 1.2),
          expectedMemoryBytes: Math.ceil(estimate * 2.2),
          minimumMinutes: 1,
          maximumMinutes: 10,
        },
      },
      preparation: {
        snapshot: () => preparation.snapshot(),
        subscribe: listener => preparation.subscribe(listener),
        prepare: request => preparation.prepare(request),
        cancel: () => preparation.cancel(),
      },
      transcribe: async (input, signal) => {
        const phase = preparation.snapshot().phase
        if (phase !== 'standby' && phase !== 'ready') {
          throw new Error('whisper: the recognition model is not prepared yet; open the voice plugin details and start setup')
        }
        return await engine.transcribe(input.audio, input.language, signal)
      },
    })
    void preparation.inspect()
    return async () => {
      const removing = unregister()
      await preparation.cancel()
      await engine.dispose()
      await removing
    }
  })
}
