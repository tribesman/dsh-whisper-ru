**English** · [Русский](README.ru.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Português](README.pt.md)

# Local Whisper speech recognition for DeepSeek Harness

A DeepSeek Harness (DSH) plugin that adds a **local Whisper recognizer** to voice input, so dictation works in **Russian** and nine other languages without sending audio to a cloud service.

DSH ships one recognizer — SenseVoiceSmall — whose model only knows Chinese, English, Cantonese, Japanese and Korean. This plugin registers a second provider in the same registry, and the existing voice input UI offers it with the language list below.

## What you get

- A **microphone dictation** flow that already exists in DSH works unchanged; only the recognizer is new.
- **Ten language hints:** `auto`, Russian, English, German, Spanish, French, Portuguese, Japanese, Chinese, Korean.
- **Fully offline recognition.** Audio is recorded by the browser, transcribed by a subprocess on the machine running DSH, and never uploaded.
- **Verified models.** Every checkpoint file is pinned by size and SHA-256 before it is used.
- **Explicit setup.** Models download once, on request, with progress, cancel and retry in the voice plugin settings.

## Requirements

| Item | Value |
| --- | --- |
| DSH | 0.2.x with the optional **voice input** bundle enabled |
| System | macOS arm64/x64, Linux x64/arm64 (glibc), Windows x64 |
| Disk | about 0.4 GB for the default model (see the model table) |
| Memory | about 0.8 GB while a model is loaded |
| Compute | CPU only; no GPU, Python or compiler needed |
| Network | one-time model download (Hugging Face or HF-Mirror) |

## Install

1. Open **Plugins** in DSH and click **Add plugin**.
2. Paste this address and confirm:

   ```text
   github:tribesman/dsh-whisper-ru
   ```

3. Open the **voice input** plugin details and press **Download and prepare**. The default `small` model takes about 376 MB.
4. In the same details page choose **Recognition service → Whisper small (INT8)** and **Recognition language → Русский**.

The Russian UI uses the same rows: **Плагины → Добавить плагин**, then in the voice plugin details **Скачать и подготовить**, **Служба распознавания**, **Язык распознавания**.

Updating later uses the same **Add plugin** dialog with the same address; DSH reinstalls the package from the repository.

## Models

The provider downloads one multilingual Whisper checkpoint in INT8 quantization. Choose it with the `model` config key.

| `model` | Disk (approx.) | Memory (approx.) | Speed on a laptop CPU | Russian quality |
| --- | --- | --- | --- | --- |
| `tiny` | 103 MB | 0.23 GB | fastest, several times faster than real time | fair, best for short phrases |
| `base` | 161 MB | 0.35 GB | fast | good |
| `small` (default) | 376 MB | 0.83 GB | about real time | very good |
| `medium` | 947 MB | 2.1 GB | slower than real time | best, needs 8 GB+ free RAM |

All four are the multilingual Whisper checkpoints published for sherpa-onnx. Recognition is CPU-only, so a longer recording takes proportionally longer.

## Languages

`auto` (detect), `ru`, `en`, `de`, `es`, `fr`, `pt`, `ja`, `zh`, `ko`.

- `auto` lets Whisper detect the language from the recording; with short clips an explicit hint is more reliable.
- Switching the hint recreates the recognizer, which costs a second or two on the next recording.
- The language list is fixed by this provider. Adding another Whisper language means editing `LANGUAGES` in `index.js`.

## Privacy

- The recording goes from the page to the DSH Host over the existing local API, then to a child process of the Host.
- No audio, text or metadata is sent to any external service. The only outbound requests are model downloads from the origin you see in the setup card.
- Models live under `$DSH_HOME/speech-to-text/whisper/<model>/` (by default `~/.dsh/speech-to-text/whisper/<model>/`). Deleting that directory removes the models; the plugin then reports the model as not prepared.
- Turning the plugin off releases the recognizer subprocess and keeps the downloaded models.

## Configuration

The bundle inserts one row, `speech-to-text-whisper`. Override it in the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: speech-to-text-whisper
  name: dsh-whisper-ru
  config:
    model: small
    dataRoot: /Users/me/.dsh/speech-to-text/whisper
    threads: 4
    modelOrigins:
      - https://huggingface.co
      - https://hf-mirror.com
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `small` | `tiny`, `base`, `small` or `medium` |
| `dataRoot` | `$DSH_HOME/speech-to-text/whisper` | absolute directory for downloaded models |
| `threads` | `4` | CPU threads used by one recognition |
| `providerId` | `whisper-local` | registry id other plugins select |
| `modelOrigins` | Hugging Face, HF-Mirror | origins compared when a download starts |
| `modelOrigin` | unset | use exactly this origin, without fallback |
| `inferenceTimeoutMs` | `300000` | deadline for one recognition |

Changing `model` changes the file set, so the new model has to be prepared again; the old files stay on disk until you delete them.

## How it works

```
browser microphone → DSH voice input → speechToText registry
    → this provider (index.js) → worker.js subprocess
        → sherpa-onnx + Whisper INT8 → text back to the draft
```

- `index.js` registers the provider, owns model preparation (download, SHA-256 verification, a `.verified.json` sidecar), and starts the worker on the first recording.
- `worker.js` runs in a separate Node process, so a long utterance never blocks the DSH Host. It parses the canonical 16 kHz mono PCM16 WAV itself, because the native addon cannot hand V8 an external buffer inside Electron.
- Recognition of the current recording can be cancelled from the UI; cancelling kills the worker and the next recording starts a fresh one.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "the recognition model is not prepared yet" | Open the voice plugin details and press **Download and prepare**. |
| Download fails with a network or HTTP error | Retry; if Hugging Face is slow or blocked, pick **HF-Mirror** as the download source in the same card. A proxy has to be configured for the machine running DSH. |
| Recognition is slow | Switch `model` to `base` or `tiny` and prepare it; keep `threads` at the number of performance cores. |
| No microphone in the UI | The page must be served over HTTPS or loopback; allow microphone access in the browser and in the system settings. |
| First recognition stalls a few seconds | The worker is loading the model. Later recordings reuse it until it is idle. |
| Text has no punctuation | Whisper adds punctuation itself; short or noisy clips may lose it. |

## Limitations

- Complete recordings only — no streaming captions, wake word or speech synthesis.
- CPU only, and the worker holds one recording at a time.
- Whisper can hallucinate words on silence or music; keep recordings clean.
- Windows on ARM and Linux musl are not verified, because the prebuilt sherpa-onnx runtime does not target them.
- Russian is recognized with Whisper's own casing and punctuation, which can differ from the text you would type.

## Development

```bash
git clone https://github.com/tribesman/dsh-whisper-ru
cd dsh-whisper-ru
pnpm install
```

The package is plain ESM with no build step: `index.js` is the Host plugin, `worker.js` is its subprocess, and `cordis.patch.yml` inserts the row. A local checkout can be installed with **Add plugin** and its absolute directory path.

## License

MIT. Whisper models are distributed by the sherpa-onnx project; sherpa-onnx itself is Apache-2.0.
