[English](README.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · **Español** · [Português](README.pt.md)

# Reconocimiento de voz local con Whisper para DeepSeek Harness

Un complemento de DeepSeek Harness (DSH) que añade un **reconocedor Whisper local** a la entrada de voz, de modo que el dictado funciona en **ruso** y en otros nueve idiomas sin enviar el audio a un servicio en la nube.

DSH incluye un único reconocedor, SenseVoiceSmall, cuyo modelo solo reconoce chino, inglés, cantonés, japonés y coreano. Este complemento registra un segundo proveedor en el mismo registro, y la interfaz de entrada de voz existente lo ofrece con la lista de idiomas que aparece más abajo.

## Lo que obtienes

- Un flujo de **dictado por micrófono** que ya existe en DSH funciona sin cambios; lo único nuevo es el reconocedor.
- **Diez sugerencias de idioma:** `auto`, ruso, inglés, alemán, español, francés, portugués, japonés, chino y coreano.
- **Reconocimiento totalmente sin conexión.** El navegador graba el audio, un subproceso de la máquina que ejecuta DSH lo transcribe y nunca se sube.
- **Modelos verificados.** Cada archivo de checkpoint se fija por tamaño y SHA-256 antes de usarse.
- **Configuración explícita.** Los modelos se descargan una sola vez, a petición, con progreso, cancelación y reintento en los ajustes del complemento de voz.

## Requisitos

| Elemento | Valor |
| --- | --- |
| DSH | 0.2.x con el bundle opcional **voice input (entrada de voz)** habilitado |
| Sistema | macOS arm64/x64, Linux x64/arm64 (glibc), Windows x64 |
| Disco | unos 0.4 GB para el modelo predeterminado (véase la tabla de modelos) |
| Memoria | unos 0.8 GB mientras hay un modelo cargado |
| Cómputo | solo CPU; no se necesita GPU, Python ni compilador |
| Red | descarga única de los modelos (Hugging Face o HF-Mirror) |

## Instalación

1. Abre **Plugins (Complementos)** en DSH y haz clic en **Add plugin (Añadir complemento)**.
2. Pega esta dirección y confirma:

   ```text
   github:tribesman/dsh-whisper-ru
   ```

3. Abre los detalles del complemento **voice input (entrada de voz)** y pulsa **Download and prepare (Descargar y preparar)**. El modelo `small` predeterminado ocupa unos 376 MB.
4. En la misma página de detalles, elige **Recognition service (Servicio de reconocimiento) → Whisper small (INT8)** y **Recognition language (Idioma de reconocimiento) → Русский**.

La interfaz en ruso usa las mismas filas: **Плагины → Добавить плагин** y, en los detalles del complemento de voz, **Скачать и подготовить**, **Служба распознавания**, **Язык распознавания**.

Para actualizar más adelante se usa el mismo diálogo **Add plugin (Añadir complemento)** con la misma dirección; DSH vuelve a instalar el paquete desde el repositorio.

## Modelos

El proveedor descarga un único checkpoint Whisper multilingüe en cuantización INT8. Se elige con la clave de configuración `model`.

| `model` | Disco (aprox.) | Memoria (aprox.) | Velocidad en la CPU de un portátil | Calidad en ruso |
| --- | --- | --- | --- | --- |
| `tiny` | 103 MB | 0.23 GB | el más rápido, varias veces más rápido que el tiempo real | aceptable, mejor para frases cortas |
| `base` | 161 MB | 0.35 GB | rápido | buena |
| `small` (predeterminado) | 376 MB | 0.83 GB | más o menos en tiempo real | muy buena |
| `medium` | 947 MB | 2.1 GB | más lento que el tiempo real | la mejor, necesita 8 GB o más de RAM libre |

Los cuatro son los checkpoints Whisper multilingües publicados para sherpa-onnx. El reconocimiento usa solo la CPU, así que una grabación más larga tarda proporcionalmente más.

## Idiomas

`auto` (detectar), `ru`, `en`, `de`, `es`, `fr`, `pt`, `ja`, `zh`, `ko`.

- Con `auto`, Whisper detecta el idioma a partir de la grabación; en clips cortos, indicarlo explícitamente resulta más fiable.
- Cambiar la sugerencia recrea el reconocedor, lo que cuesta uno o dos segundos en la siguiente grabación.
- La lista de idiomas la fija este proveedor. Añadir otro idioma de Whisper implica editar `LANGUAGES` en `index.js`.

## Privacidad

- La grabación va de la página al DSH Host a través de la API local existente y, desde ahí, a un proceso hijo del Host.
- No se envía audio, texto ni metadatos a ningún servicio externo. Las únicas peticiones salientes son las descargas de modelos desde el origen que se muestra en la tarjeta de configuración.
- Los modelos se guardan en `$DSH_HOME/speech-to-text/whisper/<model>/` (de forma predeterminada, en `~/.dsh/speech-to-text/whisper/<model>/`). Si se elimina ese directorio, se eliminan los modelos y el complemento informa de que el modelo no está preparado.
- Desactivar el complemento libera el subproceso del reconocedor y conserva los modelos descargados.

## Configuración

El bundle inserta una fila, `speech-to-text-whisper`. Sobrescríbela en el patch del perfil (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

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

| Clave | Valor predeterminado | Significado |
| --- | --- | --- |
| `model` | `small` | `tiny`, `base`, `small` o `medium` |
| `dataRoot` | `$DSH_HOME/speech-to-text/whisper` | directorio absoluto para los modelos descargados |
| `threads` | `4` | hilos de CPU que usa cada reconocimiento |
| `providerId` | `whisper-local` | id del registro que seleccionan otros complementos |
| `modelOrigins` | Hugging Face, HF-Mirror | orígenes que se comparan al iniciar una descarga |
| `modelOrigin` | sin definir | usar exactamente este origen, sin alternativa |
| `inferenceTimeoutMs` | `300000` | tiempo límite para un reconocimiento |

Cambiar `model` cambia el conjunto de archivos, así que el nuevo modelo hay que prepararlo de nuevo; los archivos antiguos permanecen en disco hasta que los elimines.

## Cómo funciona

```
browser microphone → DSH voice input → speechToText registry
    → this provider (index.js) → worker.js subprocess
        → sherpa-onnx + Whisper INT8 → text back to the draft
```

- `index.js` registra el proveedor, se encarga de la preparación de los modelos (descarga, verificación SHA-256 y un archivo adjunto `.verified.json`) e inicia el worker en la primera grabación.
- `worker.js` se ejecuta en un proceso Node independiente, de modo que una locución larga nunca bloquea el DSH Host. Analiza por sí mismo el WAV canónico de 16 kHz mono PCM16, porque el módulo nativo no puede entregar a V8 un búfer externo dentro de Electron.
- El reconocimiento de la grabación actual se puede cancelar desde la interfaz; al cancelarlo se termina el worker y la siguiente grabación inicia uno nuevo.

## Solución de problemas

| Síntoma | Qué hacer |
| --- | --- |
| «the recognition model is not prepared yet» (el modelo de reconocimiento todavía no está preparado) | Abre los detalles del complemento de voz y pulsa **Download and prepare (Descargar y preparar)**. |
| La descarga falla con un error de red o HTTP | Reintenta; si Hugging Face va lento o está bloqueado, elige **HF-Mirror** como origen de descarga en la misma tarjeta. El proxy debe configurarse en la máquina que ejecuta DSH. |
| El reconocimiento es lento | Cambia `model` a `base` o `tiny` y prepáralo; mantén `threads` en el número de núcleos de rendimiento. |
| No aparece el micrófono en la interfaz | La página debe servirse por HTTPS o por loopback; permite el acceso al micrófono en el navegador y en los ajustes del sistema. |
| El primer reconocimiento se queda parado unos segundos | El worker está cargando el modelo. Las grabaciones posteriores lo reutilizan hasta que queda inactivo. |
| El texto no tiene puntuación | Whisper añade la puntuación por su cuenta; en clips cortos o con ruido puede perderse. |

## Limitaciones

- Solo grabaciones completas: ni subtítulos en streaming, ni palabra de activación, ni síntesis de voz.
- Solo CPU, y el worker procesa una grabación a la vez.
- Whisper puede inventar palabras con el silencio o la música; mantén las grabaciones limpias.
- Windows en ARM y Linux con musl no están verificados, porque el runtime precompilado de sherpa-onnx no está destinado a ellos.
- El ruso se reconoce con el uso de mayúsculas y minúsculas y la puntuación propios de Whisper, que pueden diferir del texto que escribirías.

## Desarrollo

```bash
git clone https://github.com/tribesman/dsh-whisper-ru
cd dsh-whisper-ru
pnpm install
```

El paquete es ESM puro y no tiene paso de compilación: `index.js` es el complemento del Host, `worker.js` es su subproceso y `cordis.patch.yml` inserta la fila. Una copia local se puede instalar con **Add plugin (Añadir complemento)** y la ruta absoluta de su directorio.

## Licencia

MIT. Los modelos Whisper los distribuye el proyecto sherpa-onnx; sherpa-onnx es Apache-2.0.
