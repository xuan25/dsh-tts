# dsh-tts

Text-to-speech plugin for dsh: one `tts` tool that turns text into an audio
file (wav / mp3 / flac / aac / opus / pcm) through any OpenAI-compatible TTS
backend, so agents can voice their output without per-backend glue. The same
tool lists voices and models, probes routes, and calls the backend's dev
phonemize endpoint. It is a thin client: the audio lands on disk and container
checks are reported.

## Tool verbs

| verb        | network | what it does |
| ----------- | ------- | ------------ |
| `synth`     | yes     | synthesize (writes the audio file, runs container checks) |
| `voices`    | yes     | list voices (optionally filtered); a 404 falls back to the static OpenAI table (`source: "static"`) |
| `providers` | no      | list configured routes: fields, per-field provenance, credential state |
| `models`    | maybe   | route models: declared, or discovered via `GET {baseURL}/models` |
| `status`    | yes     | probe each route: `GET {baseURL}/models` plus an optional server-root `GET /health` |
| `phonemize` | yes     | `POST /dev/phonemize {text, language}` (server root); 404/405 = not supported |

Key `synth` behaviors:

- `voice` is required (no default; voice sets are provider-specific).
- `model` default: the route's single declared model; otherwise the call
  reports the model list and asks for an explicit `model`.
- `response_format` defaults to `wav`. The backend owns container
  correctness; the plugin validates (RIFF walk for wav, magic checks for
  mp3/flac/aac/opus) and reports: `error` = the call fails, the file is kept;
  `warnings` = known defect, e.g. placeholder RIFF header / data chunk sizes
  (`0xFFFFFFFF` or `0x7FFFFFFF`) some backends emit.
- Output path: `out` argument (file path, or a directory via trailing
  separator), else `<process.cwd()>/tts/<unixts>_<voice>.<ext>`.
- Timeouts (constants, not config): synth 180 s, probes 15 s, phonemize 30 s.

## Installation

dsh-tts is an out-of-tree plugin for a dsh profile. Install it with the dsh
plugin command:

```sh
dsh plugin --profile <name> add dsh-tts
```

Configuration is layered: built-in defaults, `DSH_TTS_*` env, a cordis patch
file, a `dsh-tts` settings section (see below); the plugin creates no config
or state files.

## Configuration

Providers are configured in any of three layers, lowest to highest priority;
per-field provenance is reported by the `providers` verb, so a shadowed value
is never silent:

1. built-in default (`api: openai-compatible`),
2. the `DSH_TTS_*` env contract (static per process boot),
3. the cordis config layer (a patch entry with id `dsh-tts` and a `config`
   object, or profile-level patches),
4. a `dsh-tts:` section in the user settings document (`$DSH_HOME/settings.yaml`)
   - re-read on every call, so settings edits apply without a restart.

### Env contract (1:1 with the config fields)

| variable | config field |
| -------- | ------------ |
| `DSH_TTS_DEFAULT_PROVIDER` | `defaultProvider` |
| `DSH_TTS_PROVIDER_<NAME>_BASEURL` | `providers.<name>.baseURL` |
| `DSH_TTS_PROVIDER_<NAME>_API` | `providers.<name>.api` |
| `DSH_TTS_PROVIDER_<NAME>_APIKEYENV` | `providers.<name>.apiKeyEnv` |
| `DSH_TTS_PROVIDER_<NAME>_HEADERS` | `providers.<name>.headers` (a JSON object string) |
| `DSH_TTS_PROVIDER_<NAME>_MODELS` | `providers.<name>.models` (comma-separated) |
| `DSH_TTS_PROVIDER_<NAME>_DISPLAYNAME` | `providers.<name>.displayName` |

`<NAME>` is the route name uppercased, non-alphanumerics become `_`
(`kokoro-local` -> `KOKORO_LOCAL`); matching between layers is
case-insensitive and treats `_` / `-` as the same separator. A route without
a base URL, or whose name does not match `^[a-z][a-z0-9-]{0,63}$` (lowercase
letter first, letters/digits/hyphens, max 64), is dropped with a warning.

`baseURL` is the **OpenAI-compatible base URL including the `/v1` prefix**
(the same shape as an LLM provider base URL, e.g. `http://kokoro-tts:8880/v1`):
the plugin appends the OpenAI paths to it verbatim
(`/audio/speech`, `/audio/voices`, `/models`), while `/health` and
`/dev/phonemize` live outside the `/v1` namespace and are addressed at the
server root, derived by stripping a trailing `/v1` from the base URL.

### Settings section

```yaml
dsh-tts:
  defaultProvider: kokoro-local
  providers:
    kokoro-local:
      baseURL: http://kokoro-tts:8880/v1
      headers:
        Authorization: Bearer not-needed   # keyless local backends
    hosted:
      baseURL: https://api.example.com/v1
      apiKeyEnv: TTS_API_KEY
      models: [speech-1]
      displayName: Hosted TTS
```

### Credentials

`apiKeyEnv` is a reference to an environment variable name (never a secret in
config). Per request the value resolves from the process environment, then
from `$DSH_HOME/.credentials.yaml` (a flat `NAME: value` mapping). An
unresolved reference on a credentialed synth is an error; discovery verbs
degrade instead of failing.

## Examples

```jsonc
// synthesize with the default route and its single declared model
{ "verb": "synth", "input": "hello world", "voice": "zf_xiaoxiao" }
// pick a route, format, speed, and output location explicitly
{ "verb": "synth", "provider": "kokoro-local", "input": "the quick brown fox",
  "voice": "zf_xiaoxiao", "response_format": "mp3", "speed": 1.1, "out": "/tmp/hi.mp3" }
// find the zh-female voices on the backend (id prefix filter)
{ "verb": "voices", "provider": "kokoro-local", "filter": "zf_" }
// or a case-insensitive substring over id and name
{ "verb": "voices", "provider": "kokoro-local", "query": "zf" }
// what is configured, and where each field comes from
{ "verb": "providers" }
// backend health
{ "verb": "status" }
```

## Troubleshooting

- `TTS_NOT_CONFIGURED` - no route survived configuration: check base URLs and
  the warnings in the provider log.
- `credential missing: environment variable "X" is not set` - set `X` in the
  environment or add it to `$DSH_HOME/.credentials.yaml`.
- `unknown provider "x"` - route names match case-insensitively with `_`/`-`
  equivalence; the error lists the configured names.
- `wav: ... placeholder ...` warning - the backend emitted placeholder RIFF
  chunk sizes (`0xFFFFFFFF` or `0x7FFFFFFF`); the payload plays, strict
  parsers misread it.
- `multiple providers configured (...) and no default is set` - pass
  `provider` explicitly or set `DSH_TTS_DEFAULT_PROVIDER` / the settings
  `defaultProvider`.

## Build

```sh
pnpm install
pnpm run build     # tsc -> lib/
pnpm run lint      # eslint src/ test/
pnpm run selftest  # in-process: HTTP stub + config matrix + container checks
```
