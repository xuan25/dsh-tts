# dsh-tts

Text-to-speech plugin for dsh: one `tts` tool that turns text into an audio
file (wav / mp3 / flac / aac / opus / pcm) through any OpenAI-compatible TTS
backend, so agents can voice their output without per-backend glue. The same
tool lists voices and models, probes the routes, and calls the backend's dev
phonemize endpoint.

## Tool verbs

| verb        | network | what it does |
| ----------- | ------- | ------------ |
| `synth`     | yes     | Synthesizes the requested speech. The tool writes the audio file to disk and runs container checks on the returned bytes. |
| `voices`    | yes     | Lists the backend voices, optionally filtered. When the backend returns 404 to `GET {baseURL}/audio/voices`, the tool serves the static OpenAI table and marks `source: static`. |
| `providers` | no      | Lists the configured routes with their fields, the originating layer of each field, and the credential state. The verb reads the local configuration and makes no network request. |
| `models`    | maybe   | Reports the model list of each route. A route with declared models reports the declared list from the config layer, and a route without declared models reports the live `GET {baseURL}/models` probe. |
| `status`    | yes     | Probes each route: the `GET {baseURL}/models` listing plus the optional server-root `GET /health` liveness probe. |
| `phonemize` | yes     | Calls the backend's `POST /dev/phonemize` endpoint at the server root. A 404 or 405 response reports the endpoint as unsupported. |

Key `synth` behaviors:

- The `voice` argument is required, and there is no default: the voice set is
  provider-specific. The available ids are listed by the `voices` verb.
- When the call omits `model`, the tool uses the route's single declared
  model. When a route declares no models, the tool resolves the model by a
  live `/models` probe. When the declared or probed model list contains
  several models, the call fails and lists the candidates.
- The `response_format` argument defaults to `wav`, and the tool sends the
  value verbatim.
- The backend owns container correctness, and the tool validates the returned
  bytes: a RIFF walk for `wav`, and magic checks for the other formats
  (`pcm` carries no container check). When the payload is not the claimed
  container, the call fails and the tool keeps the file on disk. When the
  container carries a known defect, for example the placeholder RIFF chunk
  sizes (`0xFFFFFFFF` or `0x7FFFFFFF`) some backends emit, the successful
  document reports it in `warnings`.
- When the call sets `out`, the output path is that argument (a file path, or
  a directory marked by a trailing separator or by existing on disk). When the
  call omits `out`, the tool writes the file to
  `<process.cwd()>/tts/<unixts>_<voice>.<ext>`. The file extension comes from
  the `response_format` value.
- The `speed` and `language` arguments are sent verbatim, and only when the
  call sets them.
- The synth timeout is 180 s, and the probe and phonemize timeouts are 15 s
  and 30 s.

The plugin ships a `dsh-tts` skill. The skill is the full tool reference for
agent contexts: it carries the parameter table, the env contract, and the
error shapes.

## Installation

dsh-tts is an out-of-tree plugin for a dsh profile. Install it with the dsh
plugin command:

```sh
dsh plugin --profile <name> add dsh-tts
```

Configuration is layered: built-in defaults, the `DSH_TTS_*` env contract, a
cordis patch file, a `dsh-tts` settings section (see below); the plugin
creates no config or state files.

## Configuration

Providers are configured in any of four layers, lowest to highest priority;
the `providers` verb reports the originating layer of every field, so a
shadowed value is never silent:

1. the built-in default (`api: openai-compatible`),
2. the `DSH_TTS_*` env contract (static per process boot),
3. the cordis config layer (a patch entry with id `dsh-tts` and a `config`
   object, or profile-level patches),
4. the `dsh-tts:` section in the user settings document
   (`$DSH_HOME/settings.yaml`), which the plugin re-reads on every call, so
   settings edits apply without a restart.

```yaml
dsh-tts:
  defaultProvider: local
  providers:
    local:
      baseURL: http://<host>:<port>/v1
    hosted:
      baseURL: https://api.example.com/v1
      apiKeyEnv: DSH_TTS_HOSTED_KEY
      models: [kokoro-v2]
      displayName: Hosted Speech
```

The env contract mirrors the config fields 1:1: `DSH_TTS_DEFAULT_PROVIDER`,
and per route `<NAME>` the variables `DSH_TTS_PROVIDER_<NAME>_BASEURL`,
`DSH_TTS_PROVIDER_<NAME>_API`, `DSH_TTS_PROVIDER_<NAME>_APIKEYENV`,
`DSH_TTS_PROVIDER_<NAME>_HEADERS`, `DSH_TTS_PROVIDER_<NAME>_MODELS`,
`DSH_TTS_PROVIDER_<NAME>_DISPLAYNAME`. The `<NAME>` segment is the route name
uppercased with `-` written as `_`. The `headers` value is a JSON object
string, and the `models` value is a comma-separated list of model ids. The
`baseURL` value is the OpenAI-compatible base URL including the `/v1` prefix
(the same shape as an LLM provider base URL); the plugin appends
`/audio/speech`, `/audio/voices`, and `/models` to it verbatim, and it
addresses `/health` and `/dev/phonemize` at the server root, which it derives
by stripping a trailing `/v1` from the base URL. The `apiKeyEnv` value is a
reference to an environment variable name, never a secret in config; per
request the value resolves from the process environment, then from
`$DSH_HOME/.credentials.yaml`.

## Examples

```jsonc
// Synthesize with the default route and its single declared model.
{ "verb": "synth", "input": "hello world", "voice": "zf_xiaoxiao" }
// Pick a route, format, speed, and output location explicitly.
{ "verb": "synth", "provider": "hosted", "input": "the quick brown fox",
  "voice": "zf_xiaoxiao", "response_format": "mp3", "speed": 1.1, "out": "/tmp/hi.mp3" }
// Find the voices by an id prefix filter.
{ "verb": "voices", "filter": "zf_" }
// Or by a case-insensitive substring over the id and name.
{ "verb": "voices", "query": "zf" }
// List what is configured, and where each field comes from.
{ "verb": "providers" }
// Probe the backend health (the live /models probe).
{ "verb": "status" }
// Ask the backend dev phonemize endpoint (a 404/405 response reports it as unsupported).
{ "verb": "phonemize", "text": "hello world", "language": "zh" }
```

## Troubleshooting

A failing call returns a JSON document with an `error` message field, and the
message text identifies the failure.

- When the error message is "TTS_NOT_CONFIGURED", no route survived
  configuration. Check the base URLs; the tool reports each route that
  configuration drops as a warning in the log.
- When the error message carries the text "credential missing: environment
  variable "X" is not set", the credential reference does not resolve. Set
  `X` in the environment or add it to `$DSH_HOME/.credentials.yaml`.
- When the error message carries the text "unknown provider "x"", the route
  name matches no configured route. Route names match case-insensitively and
  treat `_` and `-` as the same separator; the error lists the configured
  names.
- When the error message carries the text "multiple providers configured
  (...) and no default is set", pass the `provider` argument explicitly, or
  set `DSH_TTS_DEFAULT_PROVIDER`, or set the settings `defaultProvider`.
- When `status` reports `reachable: false`, the `error` field carries the
  cause; the probe uses a 15 s budget against `GET {baseURL}/models`.
- When `voices` reports `source: static`, the backend answered 404 to
  `GET {baseURL}/audio/voices`, and the tool returned the static OpenAI
  table. The listed voice ids may not exist on that backend.
- When the synth document carries a container check error, the tool could not
  verify the returned bytes as the claimed container. Inspect the kept file
  at `out`; the backend may return an unsupported container for the requested
  `response_format`.

## Build

```sh
pnpm install
pnpm run build     # tsc -> lib/
pnpm run lint      # eslint src/ test/
pnpm run selftest  # in-process: HTTP stub + config matrix + container checks
```
