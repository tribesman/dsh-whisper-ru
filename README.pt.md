[English](README.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [Español](README.es.md) · **Português**

# Reconhecimento de fala local com Whisper para o DeepSeek Harness

Um plugin do DeepSeek Harness (DSH) que adiciona um **reconhecedor Whisper local** à entrada de voz, para que o ditado funcione em **russo** e em outros nove idiomas sem enviar áudio para um serviço na nuvem.

O DSH já traz um reconhecedor — SenseVoiceSmall — cujo modelo conhece apenas chinês, inglês, cantonês, japonês e coreano. Este plugin registra um segundo provedor no mesmo registro, e a interface de entrada de voz existente passa a oferecê-lo com a lista de idiomas abaixo.

## O que você recebe

- Um fluxo de **ditado pelo microfone** que já existe no DSH funciona sem alterações; só o reconhecedor é novo.
- **Dez dicas de idioma:** `auto`, russo, inglês, alemão, espanhol, francês, português, japonês, chinês, coreano.
- **Reconhecimento totalmente offline.** O áudio é gravado pelo navegador, transcrito por um subprocesso na máquina que executa o DSH e nunca é enviado para fora.
- **Modelos verificados.** Cada arquivo de checkpoint é fixado por tamanho e SHA-256 antes de ser usado.
- **Configuração explícita.** Os modelos são baixados uma única vez, sob demanda, com progresso, cancelamento e nova tentativa nas configurações do plugin de voz.

## Requisitos

| Item | Valor |
| --- | --- |
| DSH | 0.2.x com o pacote opcional **voice input (entrada de voz)** habilitado |
| Sistema | macOS arm64/x64, Linux x64/arm64 (glibc), Windows x64 |
| Disco | cerca de 0.4 GB para o modelo padrão (veja a tabela de modelos) |
| Memória | cerca de 0.8 GB enquanto um modelo está carregado |
| Processamento | somente CPU; não é preciso GPU, Python nem compilador |
| Rede | download único dos modelos (Hugging Face ou HF-Mirror) |

## Instalação

1. Abra **Plugins** no DSH e clique em **Add plugin (Adicionar plugin)**.
2. Cole este endereço e confirme:

   ```text
   github:tribesman/dsh-whisper-ru
   ```

3. Abra os detalhes do plugin **voice input (entrada de voz)** e pressione **Download and prepare (Baixar e preparar)**. O modelo `small` padrão ocupa cerca de 376 MB.
4. Na mesma página de detalhes, escolha **Recognition service (Serviço de reconhecimento) → Whisper small (INT8)** e **Recognition language (Idioma de reconhecimento) → Русский**.

A interface em russo usa as mesmas linhas: **Плагины → Добавить плагин** e, nos detalhes do plugin de voz, **Скачать и подготовить**, **Служба распознавания**, **Язык распознавания**.

Atualizar depois usa o mesmo diálogo **Add plugin (Adicionar plugin)** com o mesmo endereço; o DSH reinstala o pacote a partir do repositório.

## Modelos

O provedor baixa um checkpoint Whisper multilíngue em quantização INT8. Escolha-o com a chave de configuração `model`.

| `model` | Disco (aprox.) | Memória (aprox.) | Velocidade em CPU de notebook | Qualidade em russo |
| --- | --- | --- | --- | --- |
| `tiny` | 103 MB | 0.23 GB | a mais rápida, várias vezes mais rápida que o tempo real | razoável, melhor para frases curtas |
| `base` | 161 MB | 0.35 GB | rápida | boa |
| `small` (padrão) | 376 MB | 0.83 GB | perto do tempo real | muito boa |
| `medium` | 947 MB | 2.1 GB | mais lenta que o tempo real | a melhor, precisa de 8 GB+ de RAM livre |

Todos os quatro são os checkpoints multilíngues do Whisper publicados para o sherpa-onnx. O reconhecimento usa apenas CPU, então uma gravação mais longa leva proporcionalmente mais tempo.

## Idiomas

`auto` (detectar), `ru`, `en`, `de`, `es`, `fr`, `pt`, `ja`, `zh`, `ko`.

- `auto` deixa o Whisper detectar o idioma a partir da gravação; em clipes curtos, uma dica explícita é mais confiável.
- Trocar a dica recria o reconhecedor, o que custa um ou dois segundos na próxima gravação.
- A lista de idiomas é fixa neste provedor. Adicionar outro idioma do Whisper significa editar `LANGUAGES` em `index.js`.

## Privacidade

- A gravação vai da página ao Host do DSH pela API local existente e, em seguida, a um processo filho do Host.
- Nenhum áudio, texto ou metadado é enviado a qualquer serviço externo. As únicas requisições de saída são os downloads de modelos a partir da origem mostrada no cartão de configuração.
- Os modelos ficam em `$DSH_HOME/speech-to-text/whisper/<model>/` (por padrão, `~/.dsh/speech-to-text/whisper/<model>/`). Excluir esse diretório remove os modelos; o plugin então informa que o modelo não está preparado.
- Desligar o plugin libera o subprocesso do reconhecedor e mantém os modelos baixados.

## Configuração

O pacote insere uma linha, `speech-to-text-whisper`. Sobrescreva-a no patch do perfil (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

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

| Chave | Padrão | Significado |
| --- | --- | --- |
| `model` | `small` | `tiny`, `base`, `small` ou `medium` |
| `dataRoot` | `$DSH_HOME/speech-to-text/whisper` | diretório absoluto para os modelos baixados |
| `threads` | `4` | threads de CPU usadas por um reconhecimento |
| `providerId` | `whisper-local` | id de registro que outros plugins selecionam |
| `modelOrigins` | Hugging Face, HF-Mirror | origens comparadas quando um download começa |
| `modelOrigin` | não definido | usa exatamente esta origem, sem fallback |
| `inferenceTimeoutMs` | `300000` | prazo para um reconhecimento |

Mudar `model` muda o conjunto de arquivos, então o novo modelo precisa ser preparado de novo; os arquivos antigos permanecem no disco até você excluí-los.

## Como funciona

```
browser microphone → DSH voice input → speechToText registry
    → this provider (index.js) → worker.js subprocess
        → sherpa-onnx + Whisper INT8 → text back to the draft
```

- `index.js` registra o provedor, cuida da preparação do modelo (download, verificação SHA-256, um sidecar `.verified.json`) e inicia o worker na primeira gravação.
- `worker.js` roda em um processo Node separado, então uma fala longa nunca bloqueia o Host do DSH. Ele mesmo faz o parsing do WAV PCM16 mono canônico de 16 kHz, porque o addon nativo não consegue passar um buffer externo ao V8 dentro do Electron.
- O reconhecimento da gravação atual pode ser cancelado pela interface; cancelar encerra o worker e a próxima gravação inicia um novo.

## Solução de problemas

| Sintoma | O que fazer |
| --- | --- |
| "the recognition model is not prepared yet" (o modelo de reconhecimento ainda não foi preparado) | Abra os detalhes do plugin de voz e pressione **Download and prepare (Baixar e preparar)**. |
| O download falha com erro de rede ou HTTP | Tente novamente; se o Hugging Face estiver lento ou bloqueado, escolha **HF-Mirror** como fonte de download no mesmo cartão. Um proxy precisa ser configurado na máquina que executa o DSH. |
| O reconhecimento está lento | Mude `model` para `base` ou `tiny` e prepare-o; mantenha `threads` no número de núcleos de desempenho. |
| Nenhum microfone na interface | A página precisa ser servida por HTTPS ou loopback; permita o acesso ao microfone no navegador e nas configurações do sistema. |
| O primeiro reconhecimento trava por alguns segundos | O worker está carregando o modelo. As gravações seguintes o reutilizam até ele ficar ocioso. |
| O texto não tem pontuação | O Whisper adiciona a pontuação por conta própria; clipes curtos ou com ruído podem perdê-la. |

## Limitações

- Somente gravações completas — sem legendas em streaming, palavra de ativação ou síntese de fala.
- Somente CPU, e o worker processa uma gravação por vez.
- O Whisper pode alucinar palavras em silêncio ou música; mantenha as gravações limpas.
- Windows em ARM e Linux musl não são verificados, porque o runtime sherpa-onnx pré-compilado não tem suporte a eles.
- O russo é reconhecido com a capitalização e a pontuação do próprio Whisper, que podem diferir do texto que você digitaria.

## Desenvolvimento

```bash
git clone https://github.com/tribesman/dsh-whisper-ru
cd dsh-whisper-ru
pnpm install
```

O pacote é ESM puro, sem etapa de build: `index.js` é o plugin do Host, `worker.js` é o subprocesso dele e `cordis.patch.yml` insere a linha. Um checkout local pode ser instalado com **Add plugin (Adicionar plugin)** e o caminho absoluto do diretório.

## Licença

MIT. Os modelos Whisper são distribuídos pelo projeto sherpa-onnx; o próprio sherpa-onnx é Apache-2.0.
