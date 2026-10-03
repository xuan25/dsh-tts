// dsh-tts configuration resolution.
//
// Sources, lowest to highest priority: built-in defaults (the api value),
// the DSH_TTS_* env contract, the cordis config snapshot delivered at plugin
// construction (the composed plugin-patch / profile-patch layers), and the
// live re-read of the `dsh-tts:` section of the user settings document (the
// settings file is re-read on every call, so settings edits apply without a
// restart; a field deleted from settings falls back to the layers below).
//
// Per-field provenance (FieldSource) is reported by the providers verb so a
// shadowed env value is never silent: the highest layer declaring the field
// wins and its name is the reported source; a field absent from every layer
// reports "default" (the built-in state: the api default value, or plain
// absence for the optional fields).
//
// Providers that lose validation (no baseURL, an unknown api value) or carry
// an unparseable env header block are dropped with a warning; resolution
// never throws.
import fs from 'node:fs'
import * as YAML from 'yaml'
import type {
  DeliveredConfig,
  DeliveredProfileConfig,
  FieldSource,
  ProviderProfile,
  ProviderSources,
  TtsConfig,
} from './types.js'
import { PROVIDER_NAME_RE, canonicalName, clip } from './util.js'

/** The only wire protocol the v1 adapter implements. */
export const API_OPENAI_COMPATIBLE = 'openai-compatible'

/** The user settings section key (matches the plugin entry id). */
export const SETTINGS_SECTION = 'dsh-tts'

/** Env variable holding the default route name. */
export const ENV_DEFAULT_PROVIDER = 'DSH_TTS_DEFAULT_PROVIDER'

/**
 * Matches DSH_TTS_PROVIDER_<NAME>_<FIELD>; captures name (underscored, since
 * env names cannot carry hyphens) and field.
 */
const ENV_PROVIDER_RE = /^DSH_TTS_PROVIDER_([A-Z0-9_]+)_(BASEURL|API|APIKEYENV|HEADERS|MODELS|DISPLAYNAME)$/

/** The per-field env variable names of one provider (the 1:1 env contract). */
export function providerEnvVars(name: string): Record<string, string> {
  const upper = canonicalName(name).toUpperCase().replace(/-/g, '_')
  const prefix = `DSH_TTS_PROVIDER_${upper}_`
  return {
    baseURL: `${prefix}BASEURL`,
    api: `${prefix}API`,
    apiKeyEnv: `${prefix}APIKEYENV`,
    headers: `${prefix}HEADERS`,
    models: `${prefix}MODELS`,
    displayName: `${prefix}DISPLAYNAME`,
  }
}

/** The raw per-field state parsed from the env record. */
interface EnvProviderFields {
  baseURL?: string
  api?: string
  apiKeyEnv?: string
  headers?: string
  models?: string
  displayName?: string
}

/** Maps the env field suffix to the camelCase field key. */
const ENV_FIELD_KEYS = {
  BASEURL: 'baseURL',
  API: 'api',
  APIKEYENV: 'apiKeyEnv',
  HEADERS: 'headers',
  MODELS: 'models',
  DISPLAYNAME: 'displayName',
} as const

/** The env contract parsed from an env record. */
export interface EnvContract {
  defaultProvider: string | null
  providers: Map<string, EnvProviderFields>
}

/**
 * Parse the DSH_TTS_* env contract.
 * @param env the env record (process.env at call time, or a test fixture).
 * @returns the parsed default route name and per-route raw fields.
 */
export function parseEnvContract(env: Record<string, string | undefined>): EnvContract {
  const providers = new Map<string, EnvProviderFields>()
  let defaultProvider: string | null = null
  const dv = env[ENV_DEFAULT_PROVIDER]
  if (typeof dv === 'string' && dv.trim().length > 0) defaultProvider = dv.trim()
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue
    const m = ENV_PROVIDER_RE.exec(key)
    if (m === null) continue
    const name = canonicalName(m[1])
    const fields = providers.get(name) ?? ({} as EnvProviderFields)
    const fieldKey = ENV_FIELD_KEYS[m[2] as keyof typeof ENV_FIELD_KEYS]
    fields[fieldKey] = value
    providers.set(name, fields)
  }
  return { defaultProvider, providers }
}

/** The live settings section shape (a subset of the delivered config). */
export interface SettingsSection {
  defaultProvider?: string
  providers?: Record<string, DeliveredProfileConfig>
}

/**
 * Read the `dsh-tts:` section of the user settings document (a live re-read:
 * the settings file is the hot layer). A missing file or section yields the
 * empty section; a parse failure is reported through the warn hook.
 * @param dshHome the DSH home directory (the settings file lives in it).
 * @param warn reporting hook for parse failures.
 * @returns the parsed section (possibly empty).
 */
export function readSettingsSection(dshHome: string, warn: (msg: string) => void): SettingsSection {
  const section: SettingsSection = {}
  let text: string
  try {
    text = fs.readFileSync(`${dshHome}/settings.yaml`, 'utf8')
  } catch {
    return section
  }
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch (err) {
    warn(`dsh-tts: could not parse ${dshHome}/settings.yaml (${errMsgOf(err)}); the settings layer is ignored`)
    return section
  }
  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
    const sec = (doc as Record<string, unknown>)[SETTINGS_SECTION]
    if (sec !== null && typeof sec === 'object' && !Array.isArray(sec)) {
      const s = sec as Record<string, unknown>
      if (typeof s.defaultProvider === 'string') section.defaultProvider = s.defaultProvider
      if (s.providers !== null && typeof s.providers === 'object' && !Array.isArray(s.providers)) {
        section.providers = s.providers as Record<string, DeliveredProfileConfig>
      }
    }
  }
  return section
}

/** Error message of an unknown value, clipped for log lines. */
function errMsgOf(err: unknown): string {
  return err instanceof Error ? clip(err.message, 120) : String(err)
}

/** The per-field state after the layer merge (pre-drop). */
interface MergedFields {
  apiSource: FieldSource
  baseURL: string
  baseURLSource: FieldSource
  apiKeyEnv: string | null
  apiKeyEnvSource: FieldSource
  headers: Record<string, string>
  headersSource: FieldSource
  models: string[] | null
  modelsSource: FieldSource
  displayName: string
  displayNameSource: FieldSource
}

/**
 * Resolve one provider's fields across the layers.
 * @param name canonical provider name.
 * @param envFields the provider's raw env fields (absent when env declares none).
 * @param delivered the delivered cordis profile for this name (absent when the cordis layers declare none).
 * @param settings the live settings profile for this name.
 * @param warn reporting hook (unknown api value, unparseable env header block).
 * @returns the merged fields, or null when the provider must be dropped.
 */
function mergeProvider(
  name: string,
  envFields: EnvProviderFields | undefined,
  delivered: DeliveredProfileConfig | undefined,
  settings: DeliveredProfileConfig | undefined,
  warn: (msg: string) => void,
): MergedFields | null {
  const sourceOf = (s?: unknown, d?: unknown, e?: unknown): FieldSource => {
    if (s !== undefined) return 'settings'
    if (d !== undefined) return 'cordis'
    if (e !== undefined) return 'env'
    return 'default'
  }

  // api: the only field with a built-in default value; v1 implements exactly
  // one protocol, any other declared value drops the provider.
  const api = settings?.api ?? delivered?.api ?? envFields?.api ?? API_OPENAI_COMPATIBLE
  const apiSource = sourceOf(settings?.api, delivered?.api, envFields?.api)
  if (api !== API_OPENAI_COMPATIBLE) {
    warn(`dsh-tts: provider "${name}" declares api "${clip(api, 60)}"; only "${API_OPENAI_COMPATIBLE}" is implemented, the provider is dropped`)
    return null
  }

  const baseURL = settings?.baseURL ?? delivered?.baseURL ?? envFields?.baseURL ?? ''
  const baseURLSource = sourceOf(settings?.baseURL, delivered?.baseURL, envFields?.baseURL)

  const apiKeyEnv = settings?.apiKeyEnv ?? delivered?.apiKeyEnv ?? envFields?.apiKeyEnv ?? null
  const apiKeyEnvSource = sourceOf(settings?.apiKeyEnv, delivered?.apiKeyEnv, envFields?.apiKeyEnv)

  // headers: the env layer carries a JSON object string, the config layers a
  // plain object; an unparseable env value drops the field with a warning.
  let headers: Record<string, string> = {}
  let headersSource: FieldSource = 'default'
  if (settings?.headers !== undefined) {
    headers = settings.headers
    headersSource = 'settings'
  } else if (delivered?.headers !== undefined) {
    headers = delivered.headers
    headersSource = 'cordis'
  } else if (envFields?.headers !== undefined) {
    const parsed = parseHeadersJson(name, envFields.headers, warn)
    if (parsed !== null) {
      headers = parsed
      headersSource = 'env'
    }
  }

  // models: the env layer carries a comma-separated list.
  let models: string[] | null = null
  let modelsSource: FieldSource = 'default'
  if (settings?.models !== undefined) {
    models = settings.models
    modelsSource = 'settings'
  } else if (delivered?.models !== undefined) {
    models = delivered.models
    modelsSource = 'cordis'
  } else if (envFields?.models !== undefined) {
    models = envFields.models
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    modelsSource = 'env'
  }

  const displayName = settings?.displayName ?? delivered?.displayName ?? envFields?.displayName ?? name
  const displayNameSource = sourceOf(settings?.displayName, delivered?.displayName, envFields?.displayName)

  return {
    apiSource,
    baseURL,
    baseURLSource,
    apiKeyEnv,
    apiKeyEnvSource,
    headers,
    headersSource,
    models,
    modelsSource,
    displayName,
    displayNameSource,
  }
}

/**
 * Parse the env-layer headers value (a JSON object of string values).
 * @param provider the provider name (error reporting only).
 * @param raw the raw env string.
 * @param warn reporting hook.
 * @returns the parsed header map, or null (the field is dropped).
 */
function parseHeadersJson(provider: string, raw: string, warn: (msg: string) => void): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn(`dsh-tts: provider "${provider}" headers env value is not valid JSON; the headers field is dropped`)
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`dsh-tts: provider "${provider}" headers env value is not a JSON object; the headers field is dropped`)
    return null
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Resolve the full per-call configuration snapshot.
 * @param delivered the config snapshot delivered at plugin construction.
 * @param env the live env record (process.env).
 * @param dshHome the DSH home (the settings document lives there).
 * @param warn reporting hook (dropped providers, stale defaults).
 * @returns the resolved snapshot; never throws.
 */
export function resolveConfig(
  delivered: DeliveredConfig | undefined,
  env: Record<string, string | undefined>,
  dshHome: string,
  warn: (msg: string) => void,
): TtsConfig {
  const envContract = parseEnvContract(env)
  const liveSettings = readSettingsSection(dshHome, warn)

  // Provider names in configuration order: env first, then the cordis layers,
  // then the settings layer; the same provider spelled in several layers
  // merges under one canonical name (underscore/hyphen are equivalent).
  const names: string[] = []
  const seen = new Set<string>()
  const addName = (raw: string): void => {
    const n = canonicalName(raw)
    if (!PROVIDER_NAME_RE.test(n)) {
      warn(`dsh-tts: provider "${clip(n, 60)}" is not a valid name (expected a lowercase letter start, letters/digits/hyphens, max 64); the provider is dropped`)
      return
    }
    if (!seen.has(n)) {
      seen.add(n)
      names.push(n)
    }
  }
  for (const n of envContract.providers.keys()) addName(n)
  if (delivered?.providers !== undefined) for (const n of Object.keys(delivered.providers)) addName(n)
  if (liveSettings.providers !== undefined) for (const n of Object.keys(liveSettings.providers)) addName(n)

  const providers: ProviderProfile[] = []
  for (const name of names) {
    const merged = mergeProvider(
      name,
      envContract.providers.get(name),
      delivered?.providers?.[name],
      liveSettings.providers?.[name],
      warn,
    )
    if (merged === null) continue
    if (merged.baseURL.trim().length === 0) {
      warn(`dsh-tts: provider "${name}" has no baseURL (set ${providerEnvVars(name).baseURL} or configure the ${SETTINGS_SECTION} settings section); the provider is dropped`)
      continue
    }
    const sources: ProviderSources = {
      api: merged.apiSource,
      baseURL: merged.baseURLSource,
      apiKeyEnv: merged.apiKeyEnvSource,
      headers: merged.headersSource,
      models: merged.modelsSource,
      displayName: merged.displayNameSource,
    }
    providers.push({
      name,
      displayName: merged.displayName,
      api: API_OPENAI_COMPATIBLE,
      baseURL: merged.baseURL,
      apiKeyEnv: merged.apiKeyEnv,
      headers: merged.headers,
      models: merged.models,
      sources,
    })
  }

  // Default route: settings, then cordis, then env; a name that is invalid or
  // points at a dropped provider is ignored with a warning.
  let defaultProvider: string | null = null
  let defaultProviderSource: FieldSource | null = null
  if (liveSettings.defaultProvider !== undefined) {
    defaultProvider = canonicalName(liveSettings.defaultProvider)
    defaultProviderSource = 'settings'
  } else if (delivered?.defaultProvider !== undefined) {
    defaultProvider = canonicalName(delivered.defaultProvider)
    defaultProviderSource = 'cordis'
  } else if (envContract.defaultProvider !== null) {
    defaultProvider = canonicalName(envContract.defaultProvider)
    defaultProviderSource = 'env'
  }
  if (defaultProvider !== null) {
    if (!PROVIDER_NAME_RE.test(defaultProvider)) {
      warn(`dsh-tts: default provider "${clip(defaultProvider, 60)}" is not a valid name; the default is ignored`)
      defaultProvider = null
      defaultProviderSource = null
    } else if (!providers.some((p) => p.name === defaultProvider)) {
      warn(`dsh-tts: default provider "${defaultProvider}" is not configured; the default is ignored`)
      defaultProvider = null
      defaultProviderSource = null
    }
  }

  return { defaultProvider, defaultProviderSource, providers, configured: providers.length > 0 }
}
