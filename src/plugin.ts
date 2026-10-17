// dsh-tts: text-to-speech plugin for dsh.
// One tts tool (synth / voices / providers / models / status / phonemize verbs)
// over OpenAI-compatible TTS backends. Providers are configured through the
// TTS_* env contract (static per process boot) and/or the cordis config
// layer delivered by the loader (a patch entry targeting this plugin's id with
// a `config` object) and/or a `dsh-tts:` section in the user settings document
// (re-read on every call, so settings edits apply without a restart).
// Pure client: no state, no tick - the plugin registers exactly three things
// in the constructor: the tts tool, the bundled dsh-tts skill, and a one-line
// system-prompt pointer.
import Schema from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME, PROVIDER_NAME_RE } from './util.js'
import type { DeliveredConfig } from './types.js'
import { registerSkill } from './skill.js'
import { registerTool } from './tool.js'

/** The declared per-provider fields (the camelCase mirror of the env fields). */
const PROVIDER_FIELDS = {
  api: 'the wire protocol; the only v1 value is "openai-compatible"',
  baseURL: 'the OpenAI-compatible base URL including the /v1 prefix (the same shape as an LLM provider base URL, e.g. http://<host>:<port>/v1); the plugin appends /audio/speech, /audio/voices, /models, and addresses /health and /dev/phonemize at the server root (a trailing /v1 is stripped)',
  apiKeyEnv: 'the environment variable name holding the key (resolved per request: process env, then <dshHome>/.credentials.yaml); absent = no key needed',
  headers: 'extra per-request headers (an explicit Authorization entry wins over the credential)',
  models: 'the declared model ids (absent = discover online from /models at call time)',
  displayName: 'the display name (defaults to the provider name)',
} as const

/** The label of the per-provider schema in validation messages. */
const PROVIDER_CONFIG_LABEL = 'a provider config of dsh-tts'

/**
 * Wrap a schema so any object key beyond the declared set is a validation
 * failure: the framework would otherwise merge unknown keys into the
 * validated output, letting a patch-file typo pass silently. The guard relies
 * on schemastery running the transform callback with preserve=false, i.e. on
 * both the resolved value and the original input (where unknown keys
 * survive; strict object resolution alone would strip them first). If the
 * transform ever grows a preserve option, the callback must stay on the
 * preserve=false (dual-input) behavior or this guard silently disables. The
 * loader does not forward options into the transform callback, so the error
 * is raised with an empty option set; the message carries the unknown key
 * and the declared set.
 * @param inner the object schema to guard.
 * @param label the label used in the failure message.
 */
function rejectUnknownKeys(inner: Schema, label: string): Schema {
  const declared = inner.dict ? Object.keys(inner.dict) : []
  const declaredSet = new Set(declared)
  return Schema.transform(inner, (value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!declaredSet.has(key)) {
          throw new Schema.ValidationError(
            `unknown key "${key}" in ${label} (known keys: ${declared.join(', ')})`,
            {},
          )
        }
      }
    }
    return value
  })
}

/** One provider of the config layer (the camelCase mirror of the env fields). */
const PROVIDER_CONFIG = rejectUnknownKeys(
  Schema.object({
    api: Schema.string().description(PROVIDER_FIELDS.api),
    baseURL: Schema.string().description(PROVIDER_FIELDS.baseURL),
    apiKeyEnv: Schema.string().description(PROVIDER_FIELDS.apiKeyEnv),
    headers: Schema.dict(Schema.string(), Schema.string()).description(PROVIDER_FIELDS.headers),
    models: Schema.array(Schema.string()).description(PROVIDER_FIELDS.models),
    displayName: Schema.string().description(PROVIDER_FIELDS.displayName),
  }),
  PROVIDER_CONFIG_LABEL,
)

/**
 * dsh-tts plugin (class form).
 * The constructor performs synchronous initialization (logger, tool and skill
 * registration, system-prompt section); configuration itself is resolved on
 * every call (the settings layer is hot; env is static per process boot).
 * inject = every service the plugin reads: the dsh host services tools /
 * skills / systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt:
 * ctx.tools.register / ctx.skills.registerProvider / ctx.systemPrompt.section).
 * Declaring them converts a host-missing-the-service failure from a cryptic
 * property error into the clear `cannot get required service "X"`, keeping
 * the declaration consistent with the actual read sites (same convention as
 * dsh-ntfy / dsh-imagegen). A declared service with no implementation parks
 * the plugin fiber (it never activates, it does not throw).
 * The static Config schema validates the delivered config layer before the
 * constructor runs (a violation fails the entry loudly); the layer is then
 * folded onto the env contract at call time through resolveConfig, with
 * per-field provenance reported by the providers verb.
 */
export class DshTtsPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools', 'skills', 'systemPrompt']
  static readonly Config = rejectUnknownKeys(
    Schema.object({
      defaultProvider: Schema.string().description('the provider route used when a call names no provider'),
      providers: Schema.dict(PROVIDER_CONFIG, Schema.string().pattern(PROVIDER_NAME_RE).description('the provider route name')),
    }),
    'the dsh-tts config',
  )

  constructor(ctx: Context, config: DeliveredConfig | undefined) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    registerTool(ctx, config, (msg) => logger.warn(msg))
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Synthesize speech from OpenAI-compatible TTS backends with the tts tool ' +
        '(verbs: synth, voices, providers, models, status, phonemize). ' +
        'Providers are configured via the TTS_* env contract or a dsh-tts: section in the user ' +
        'settings document; see the dsh-tts README for the config contract. ' +
        'The plugin writes audio files to disk and reports container checks; delivering a file ' +
        'is the agent\'s job.',
    })
  }
}

export default DshTtsPlugin
