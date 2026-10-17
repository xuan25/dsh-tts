// dsh-tts tts tool: one tool, six verbs.
//   synth       synthesize speech (writes the audio file, validates the container)
//   voices      list voices (live endpoint; a 404 falls back to the static OpenAI table)
//   providers   list the configured routes locally (zero network), with per-field
//               provenance and the credential state (no values)
//   models      list models per route (declared models, or online discovery)
//   status      probe each route (model listing plus optional health)
//   phonemize   call the backend dev phonemize endpoint (404/405 = not supported)
// The parameter schema is a strict declaration: the framework validates arguments
// against it before execute and rejects type/required violations with an
// `invalid arguments` error; per-verb required fields (input/voice for synth,
// text for phonemize) are checked here because one schema serves all verbs.
// The canonical output is a string (the framework renders it as one text block):
// the verb results are serialized JSON documents, and a missing/unknown verb is
// plain text, mirroring the dsh-ntfy / dsh-timer output convention.
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { DeliveredConfig, ProviderProfile, SynthParams, TtsConfig } from './types.js'
import { resolveConfig } from './config.js'
import { resolveCredential } from './credentials.js'
import { listModels, listVoices, phonemize, probe, synthesize, TtsHttpError } from './client.js'
import { verifyAudio } from './verify.js'
import { canonicalName, dshHomeFromEnv, errMsg, fileSafe } from './util.js'

/** The verb set of the tts tool. */
export const VERBS = ['synth', 'voices', 'providers', 'models', 'status', 'phonemize'] as const

/** The default synth output root: the process working directory + tts. */
export function defaultOutRoot(cwd: string): string {
  return path.join(cwd, 'tts')
}

/**
 * Resolve the synth output destination: an explicit out (a directory when it
 * ends with a path separator, a file path otherwise), else the auto name
 * <unixts>_<voice>.<ext> under the default root.
 * @param out the explicit out argument (empty/undefined = auto).
 * @param voice the voice id (the auto file name component).
 * @param format the response format (the file extension).
 * @param cwd the process working directory (the auto root).
 * @returns the absolute output file path (the parent directory is created on write).
 */
export function resolveOutPath(out: string | undefined, voice: string, format: string, cwd: string): string {
  const ext = format === 'pcm' ? 'pcm' : format
  const autoName = `${Math.floor(Date.now() / 1000)}_${fileSafe(voice)}.${ext}`
  if (out === undefined || out.length === 0) return path.join(defaultOutRoot(cwd), autoName)
  // The trailing-separator marker must be read from the raw argument: path.resolve
  // strips it, which would leave the directory branch unreachable.
  const asDir = out.endsWith('/') || out.endsWith('\\')
  const p = path.resolve(cwd, out)
  if (asDir) return path.join(p, autoName)
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.join(p, autoName)
  return p
}

/**
 * Pick the provider route: an explicit argument, else the configured default,
 * else the sole route.
 * @param cfg the resolved configuration snapshot.
 * @param argProvider the explicit provider argument (or undefined).
 * @returns the route, or an error message (one of the two is always set).
 */
function pickProvider(cfg: TtsConfig, argProvider: string | undefined): { profile?: ProviderProfile; error?: string } {
  const names = cfg.providers.map((p) => p.name).join(', ')
  if (argProvider !== undefined && argProvider.length > 0) {
    const n = canonicalName(argProvider)
    const found = cfg.providers.find((p) => p.name === n)
    if (found === undefined) return { error: `unknown provider "${n}" (configured: ${names})` }
    return { profile: found }
  }
  if (cfg.defaultProvider !== null) {
    const found = cfg.providers.find((p) => p.name === cfg.defaultProvider)
    if (found === undefined) return { error: `default provider "${cfg.defaultProvider}" is not configured` }
    return { profile: found }
  }
  if (cfg.providers.length === 1) return { profile: cfg.providers[0] }
  if (cfg.providers.length > 1) {
    return { error: `multiple providers configured (${names}) and no default is set; pass the provider argument explicitly` }
  }
  return { error: 'TTS_NOT_CONFIGURED: no provider route is configured (see the dsh-tts README: TTS_* env or the dsh-tts: settings section)' }
}

/** One route entry of the providers result. */
function providerEntry(p: ProviderProfile, cfg: TtsConfig, dshHome: string, env: Record<string, string | undefined>) {
  let credential: string
  if (p.apiKeyEnv === null) credential = 'not-configured'
  else credential = resolveCredential(p.apiKeyEnv, dshHome, env) !== null ? 'ok' : 'missing'
  return {
    name: p.name,
    display_name: p.displayName,
    api: p.api,
    base_url: p.baseURL,
    models: p.models,
    is_default: cfg.defaultProvider === p.name,
    credential,
    fields: {
      api: p.sources.api,
      base_url: p.sources.baseURL,
      api_key_env: p.sources.apiKeyEnv,
      headers: p.sources.headers,
      models: p.sources.models,
      display_name: p.sources.displayName,
    },
  }
}

/**
 * Register the tts tool (six verbs over OpenAI-compatible TTS backends).
 * @param ctx cordis Context (the host must have loaded the dsh-tools service).
 * @param delivered the config snapshot delivered at plugin construction.
 * @param warn reporting hook (config drop warnings; logger-backed in production).
 * @returns framework effect disposer (unregisters the tool when the fiber is unloaded).
 */
export function registerTool(ctx: Context, delivered: DeliveredConfig | undefined, warn: (msg: string) => void): () => void {
  const dshHome = dshHomeFromEnv(process.env)
  return ctx.tools.register(
    defineTool({
      name: 'tts',
      description:
        'Synthesize speech and query TTS backends through OpenAI-compatible endpoints. ' +
        'Providers are configured via the TTS_* env contract or a dsh-tts: section in the user settings ' +
        'document (a provider needs at least a base URL). ' +
        'synth writes the audio file to disk (default: <cwd>/tts/; pass out to choose) and reports container checks. ' +
        'voices lists the backend voices (a 404 falls back to the static OpenAI table). ' +
        'providers lists the configured routes locally with per-field provenance and credential state. ' +
        'models lists route models (declared or discovered online). ' +
        'status probes each route (model listing plus optional health). ' +
        'phonemize calls the backend dev phonemize endpoint (404/405 reports not supported). ' +
        'The produced file stays on disk; delivering it is the agent\'s job.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
        input: { type: 'string', description: 'Text to synthesize (synth: required, non-empty). Kept verbatim, the backend decides phonemization.' },
        voice: { type: 'string', description: 'Voice id (synth: required; discover it with the voices verb). No default: the backend voice set is provider-specific.' },
        provider: {
          type: 'string',
          description:
            'Provider route name (see the providers verb). Absent: the configured default, or the sole route when exactly one is configured; otherwise the call asks for an explicit provider.',
        },
        model: {
          type: 'string',
          description:
            'Model id (synth). Absent: the route is used when it declares exactly one model; else the call reports the declared (or discovered) model list and asks for an explicit model.',
        },
        response_format: {
          type: 'string',
          description:
            'Output container for synth (default: wav). The backend owns container correctness; the plugin validates the returned bytes and reports defects, it never re-wraps them. Known containers: wav, mp3, flac, aac, opus, pcm (no container check for pcm).',
        },
        speed: { type: 'number', description: 'Speech rate multiplier for synth (verbatim; the backend validates its range, e.g. 0.5-2.0). Absent: the backend default.' },
        language: {
          type: 'string',
          description: 'Language code for synth and phonemize (verbatim passthrough: some backends accept it, others reject unknown keys; the backend error surfaces as-is). Absent: the backend default.',
        },
        out: {
          type: 'string',
          description:
            'synth output location: a file path, or a directory (a trailing separator marks it as one; an existing directory counts) receiving the auto name <unixts>_<voice>.<ext>. Absent: <process.cwd()>/tts/<auto name>.',
        },
        filter: {
          type: 'string',
          description:
            'voices filter: a case-insensitive prefix matched against the voice id (e.g. "zf_" for the zh-female voices of a Kokoro backend). Absent: no prefix restriction.',
        },
        query: {
          type: 'string',
          description:
            'voices filter: a case-insensitive substring matched against voice id and name (e.g. "zf" for the zh-female voices of a Kokoro backend). Absent: no substring restriction.',
        },
        text: { type: 'string', description: 'Text to phonemize (phonemize: required, non-empty).' },
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const verb = args?.verb
        if (verb === undefined) return `missing verb (${VERBS.join('/')})`
        if (!VERBS.includes(verb)) return `unknown verb: ${String(verb)}`

        const cfg = resolveConfig(delivered, process.env, dshHome, warn)
        const env = process.env
        const err = (message: string, extra: Record<string, unknown> = {}): string =>
          JSON.stringify({ error: message, ...extra })

        // providers works unconfigured (it reports the dormant state).
        if (verb === 'providers') {
          const doc = cfg.configured
            ? {
                configured: true,
                default: cfg.defaultProvider,
                default_source: cfg.defaultProviderSource,
                providers: cfg.providers.map((p) => providerEntry(p, cfg, dshHome, env)),
              }
            : { configured: false, default: null, providers: [] }
          return JSON.stringify(doc)
        }
        if (!cfg.configured) return err('TTS_NOT_CONFIGURED', { hint: 'configure a provider via the TTS_* env contract or a dsh-tts: section in the user settings document' })

        const provider = pickProvider(cfg, typeof args?.provider === 'string' ? args.provider : undefined)
        if (provider.profile === undefined) return err(provider.error ?? 'provider resolution failed')
        const p = provider.profile

        if (verb === 'voices') {
          try {
            const r = await listVoices(p, dshHome, env)
            const f = typeof args?.filter === 'string' && args.filter.length > 0 ? args.filter.toLowerCase() : null
            const q = typeof args?.query === 'string' && args.query.length > 0 ? args.query.toLowerCase() : null
            let voices = r.voices
            if (f !== null) voices = voices.filter((v) => v.id.toLowerCase().startsWith(f))
            if (q !== null) voices = voices.filter((v) => v.id.toLowerCase().includes(q) || (v.name ?? '').toLowerCase().includes(q))
            return JSON.stringify({ provider: p.name, source: r.source, count: voices.length, voices })
          } catch (e) {
            return err(`voices: ${errMsg(e)}`)
          }
        }

        if (verb === 'models') {
          const targets = typeof args?.provider === 'string' ? [p] : cfg.providers
          const out = []
          for (const t of targets) {
            if (t.models !== null) {
              out.push({ provider: t.name, source: 'config', models: t.models })
            } else {
              try {
                out.push({ provider: t.name, source: 'discovered', models: await listModels(t, dshHome, env) })
              } catch (e) {
                out.push({ provider: t.name, source: 'unavailable', error: errMsg(e) })
              }
            }
          }
          return JSON.stringify(targets.length === 1 ? out[0] : { providers: out })
        }

        if (verb === 'status') {
          const targets = typeof args?.provider === 'string' ? [p] : cfg.providers
          const out = []
          for (const t of targets) out.push({ provider: t.name, ...(await probe(t, dshHome, env)) })
          return JSON.stringify(targets.length === 1 ? out[0] : { providers: out })
        }

        if (verb === 'phonemize') {
          const text = typeof args?.text === 'string' ? args.text : ''
          if (text.length === 0) return err('phonemize: text is required (non-empty)')
          try {
            const r = await phonemize(p, dshHome, env, text, typeof args?.language === 'string' ? args.language : undefined)
            if (!r.supported) return JSON.stringify({ provider: p.name, supported: false, error: 'backend does not implement /dev/phonemize' })
            return JSON.stringify({ provider: p.name, supported: true, result: r.result })
          } catch (e) {
            return err(`phonemize: ${errMsg(e)}`)
          }
        }

        // verb === 'synth'
        const input = typeof args?.input === 'string' ? args.input : ''
        const voice = typeof args?.voice === 'string' ? args.voice : ''
        if (input.length === 0) return err('synth: input is required (non-empty text)')
        if (voice.length === 0) return err('synth: voice is required (discover it with the voices verb)')
        const format = typeof args?.response_format === 'string' && args.response_format.length > 0 ? args.response_format : 'wav'

        // Model: explicit, else the route's single declared model, else the
        // discovered single model, else ask for an explicit model.
        let model = typeof args?.model === 'string' && args.model.length > 0 ? args.model : undefined
        if (model === undefined) {
          if (p.models !== null) {
            if (p.models.length === 1) model = p.models[0]
            else return err(`provider "${p.name}" declares ${p.models.length} models (${p.models.join(', ')}); pass the model argument explicitly`)
          } else {
            try {
              const discovered = await listModels(p, dshHome, env)
              if (discovered.length === 1) model = discovered[0]
              else return err(`provider "${p.name}" exposes ${discovered.length} models (${discovered.join(', ')}); pass the model argument explicitly`)
            } catch (e) {
              return err(`provider "${p.name}" declares no model and discovery failed: ${errMsg(e)}`)
            }
          }
        }

        const params: SynthParams = { input, voice, model, responseFormat: format }
        if (typeof args?.speed === 'number') params.speed = args.speed
        if (typeof args?.language === 'string' && args.language.length > 0) params.language = args.language
        const out = resolveOutPath(typeof args?.out === 'string' ? args.out : undefined, voice, format, process.cwd())

        const t0 = Date.now()
        try {
          const { buf } = await synthesize(p, dshHome, env, params)
          const elapsedS = Math.round(((Date.now() - t0) / 1000) * 1000) / 1000
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, buf)
          const check = verifyAudio(format, buf)
          if (check.error !== undefined) {
            return JSON.stringify({ error: check.error, out, provider: p.name, model, voice, response_format: format, bytes: buf.length })
          }
          const result: Record<string, unknown> = {
            out,
            provider: p.name,
            model,
            voice,
            response_format: format,
            bytes: buf.length,
            sample_rate: check.sampleRate,
            duration_s: check.durationS === null ? null : Math.round(check.durationS * 1000) / 1000,
            elapsed_s: elapsedS,
          }
          if (check.warnings.length > 0) result.warnings = check.warnings
          return JSON.stringify(result)
        } catch (e) {
          if (e instanceof TtsHttpError) return JSON.stringify({ error: `backend: ${e.message}`, provider: p.name, model, voice, response_format: format })
          return JSON.stringify({ error: `synth failed: ${errMsg(e)}`, provider: p.name, model, voice, response_format: format })
        }
      },
    }),
  )
}
