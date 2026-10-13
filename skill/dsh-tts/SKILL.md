---
name: dsh-tts
description: "Synthesizes speech and queries TTS backends through OpenAI-compatible endpoints with the tts tool, which exposes the synth, voices, providers, models, status, and phonemize verbs. Providers are configured through the DSH_TTS_* env contract or a dsh-tts: settings section. The tool writes the audio file to disk and reports container checks."
whenToUse: "Use this skill when the user asks to synthesize speech or read text aloud, or to inspect the configured TTS providers, voices, models, or the live backend status."
---

# dsh-tts

Synthesize speech through OpenAI-compatible TTS backends. A provider route is
an endpoint: a base URL including the /v1 prefix, plus an optional credential
reference, an optional declared model list, and optional headers. The tool
resolves the routes per the config layering below on every call. It makes one
request per call, and a failing call reports its error.

## Quick reference

```
tts { verb: "synth", input: "Good morning", voice: "zf_xiaoxiao" }
tts { verb: "synth", input: "Hello, world", provider: "local",
      response_format: "mp3", speed: 1.2, out: "speech/" }
tts { verb: "voices", query: "zf" }
tts { verb: "providers" }
tts { verb: "models" }
tts { verb: "status" }
tts { verb: "phonemize", text: "hello world", language: "zh" }
```

- The `synth` verb writes the audio file to disk and returns
  `{ out, provider, model, voice, response_format, bytes, sample_rate,
  duration_s, elapsed_s }` (the `warnings` key carries the non-fatal container
  findings). The `sample_rate` and `duration_s` values are `null` for `pcm`
  and for formats the tool cannot parse. When the container check fails, the
  document is `{ error, out, provider, model, voice, response_format, bytes }`
  and the file stays on disk for inspection. When the request itself fails,
  the document is `{ error, provider, model, voice, response_format }`.
- The `voices` verb lists the backend voices and returns
  `{ provider, source, count, voices }`. The `source` value is `live` when the
  backend answered `GET {baseURL}/audio/voices`, and `static` when that
  endpoint returns 404 and the tool falls back to the static OpenAI table
  (alloy, echo, fable, onyx, nova, shimmer). The `filter` argument is a
  case-insensitive prefix matched against the voice id, and the `query`
  argument is a case-insensitive substring matched against the voice id and
  name.
- The `providers` verb lists the configured routes from the local
  configuration; for every field it reports the originating layer
  (`default` / `env` / `cordis` / `settings`) and the credential state
  (`ok` / `missing` / `not-configured`). The verb makes no network request,
  and it works unconfigured (it reports the dormant state).
- The `models` verb reports the model list of each route; it makes one
  network request only for a route that has no declared models. A route with
  declared models reports `{ provider, source: "config", models }`; a route
  without declared models reports `{ provider, source: "discovered", models }`
  from the live `GET {baseURL}/models` probe, or
  `{ provider, source: "unavailable", error }` when that probe fails.
- The `status` verb probes each route and reports
  `{ provider, reachable: true, models, health }` for a reachable route (the
  `health` key is absent when the optional server-root `GET /health` probe
  fails), or `{ provider, reachable: false, error }` when the model listing
  fails.
- The `phonemize` verb calls the backend dev endpoint and reports
  `{ provider, supported: true, result }`, or
  `{ provider, supported: false, error }` when the backend does not implement
  `POST /dev/phonemize` (the 404/405 response).
- When the tool targets several routes (no `provider` argument, and more than
  one route is configured), the `models` and `status` results are wrapped in a
  `{ providers: [...] }` envelope; a single target returns the bare object.

## Parameter set (synth)

| Parameter | Notes |
|---|---|
| `input` | The argument is required and must be non-empty. The tool sends it verbatim, and the backend decides phonemization. |
| `voice` | The argument is required, and there is no default: the voice set is provider-specific. The agent discovers the available ids with the `voices` verb. |
| `provider` | The argument names a route. When it is absent, the tool uses the configured default, or the sole route when exactly one is configured; otherwise the call fails and the error lists the configured names. |
| `model` | The argument names a model id. When it is absent, the tool uses the route's single declared model, or the single model from the live `/models` probe; when the declared or probed list contains several models, the call fails and lists the candidates. |
| `response_format` | The tool sends the value verbatim, and its default is `wav`. The known values are `wav`, `mp3`, `flac`, `aac`, `opus`, and `pcm`. The backend owns container correctness, and the tool validates the returned bytes (a RIFF walk for `wav`, magic checks for the other formats; `pcm` carries no container check). |
| `speed` | The tool sends the value verbatim, and the backend validates its range. |
| `language` | The tool sends the value verbatim; some backends accept the code and others reject unknown values. |
| `out` | The argument is a file path, or a directory (a trailing separator marks it as one, and an existing directory counts) that receives the auto name `<unixts>_<voice>.<ext>`. When it is absent, the tool writes the file to `<process.cwd()>/tts/`. The extension matches the `response_format` value. |

The wire body sends `model`, `input`, `voice`, and `response_format`, plus
only the set keys (`speed`, `language`). The `synth` request is
`POST {baseURL}/audio/speech` with an OpenAI-shaped body and a binary
response; the `status` and `phonemize` verbs address the server-root
endpoints `GET /health` (an optional liveness probe) and `POST /dev/phonemize`
at the server root, which the tool derives by stripping a trailing `/v1` from
the base URL (a base URL without the `/v1` suffix is used as the root).
Timeouts are constants: synth 180 s, probes 15 s, phonemize 30 s.

## Env contract

| Variable | Config field |
|---|---|
| `DSH_TTS_DEFAULT_PROVIDER` | `defaultProvider` |
| `DSH_TTS_PROVIDER_<NAME>_BASEURL` | `providers.<name>.baseURL` |
| `DSH_TTS_PROVIDER_<NAME>_API` | `providers.<name>.api`; the plugin implements only `openai-compatible` |
| `DSH_TTS_PROVIDER_<NAME>_APIKEYENV` | `providers.<name>.apiKeyEnv`; the field is the name of an environment variable, and it never carries the secret itself |
| `DSH_TTS_PROVIDER_<NAME>_HEADERS` | `providers.<name>.headers`; the value is a JSON object string |
| `DSH_TTS_PROVIDER_<NAME>_MODELS` | `providers.<name>.models`; the value is a comma-separated list of model ids |
| `DSH_TTS_PROVIDER_<NAME>_DISPLAYNAME` | `providers.<name>.displayName` |

The `<NAME>` segment is the route name uppercased with `-` written as `_`
(the route `my-backend` maps to `MY_BACKEND`). Route matching is
case-insensitive and treats `_` and `-` as the same separator. A route
without a base URL, or with an invalid name (`^[a-z][a-z0-9-]{0,63}$`), is
dropped with a warning; the remaining routes are unaffected. The `baseURL`
value is the OpenAI-compatible base URL **including the `/v1` prefix**, and
the plugin appends `/audio/speech`, `/audio/voices`, and `/models` to it
verbatim; the server-root endpoints are addressed per the wire paragraph
above.

## Config layering

The layers, from lowest to highest priority, are the built-in defaults
(`api: openai-compatible`); the `DSH_TTS_*` env contract; a cordis patch
entry with id `dsh-tts` (or profile-level patches); and the `dsh-tts:`
section in the user settings document (`$DSH_HOME/settings.yaml`). The tool
re-reads the settings document on every call, so settings edits apply without
a restart. An example:

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
```

## Credentials

The `apiKeyEnv` field is a reference to an environment variable name, and it
never carries the secret in config. Per request the tool resolves the value
from the process environment, then from `$DSH_HOME/.credentials.yaml` (the
file is a flat `NAME: value` mapping). The tool adds a `Bearer` header only
when the reference resolves; an explicit `Authorization` entry in the profile
headers wins over the credential reference. An unresolved reference fails the
`synth` verb (the call is meaningless without the key), and the query verbs
degrade instead of failing (they send the profile headers only).

## Error shapes

Every failure reports a JSON document with an `error` message field; a
missing or unknown verb reports plain text instead. The message text
identifies the shape:

| error text | meaning |
|---|---|
| `TTS_NOT_CONFIGURED` | No provider route is configured; the document carries a `hint` that points to the `DSH_TTS_*` env contract or the `dsh-tts:` settings section. |
| `unknown provider "x" (configured: ...)` | The provider argument names a route that is not configured; the message lists the configured names. |
| `default provider "x" is not configured` | The configured default name matches no route. |
| `multiple providers configured (...) and no default is set; pass the provider argument explicitly` | More than one route is configured, no default is set, and the call passed no provider argument. |
| `synth: input is required (non-empty text)` / `synth: voice is required (discover it with the voices verb)` | A required synth argument is missing or empty. |
| `provider "x" declares N models (...)` / `provider "x" exposes N models (...)` | The `model` argument is absent and the declared (or probed) list holds more than one model; the message lists the candidates. |
| `backend: HTTP <status>: <body clip>` | The backend returned a non-2xx response; the message carries the status and a 400-character body clip. |
| `synth failed: <cause>` | The request or the write failed for another reason (a refused connection, the 180 s timeout budget, or a disk write error). |
| a container check message (for example `output is not a RIFF/WAVE container (the backend claimed response_format "wav")`) | The returned bytes are not the container the backend claimed; the file is kept on disk and the document carries `out` and `bytes`. |

## Troubleshooting

- When the error is `TTS_NOT_CONFIGURED`, set at least one route
  (`DSH_TTS_PROVIDER_<NAME>_BASEURL` or the settings section).
- When the error message carries the text `credential missing: environment
  variable "X" is not set`, set `X` in the environment or add it to
  `$DSH_HOME/.credentials.yaml`.
- When the error carries `unknown provider "x"`, route names match
  case-insensitively and treat `_` and `-` as the same separator; the error
  lists the configured names.
- When `status` reports `reachable: false`, the `error` field carries the
  cause; the probe uses a 15 s budget against `GET {baseURL}/models`.
- When `voices` reports `source: "static"`, the backend answered 404 to
  `GET {baseURL}/audio/voices` (or the endpoint is absent), and the tool
  returned the static OpenAI table; the listed voice ids may not exist on the
  backend.
- When the synth document carries a container check error, inspect the kept
  file at `out`; the backend may return an unsupported container for the
  requested `response_format`.
