// dsh-tts shared types: the resolved provider profile, the per-call config
// snapshot, and the verb result shapes.
//
// Layer model (lowest to highest priority):
//   1. built-in defaults (api only),
//   2. the TTS_* env contract (static per process boot),
//   3. the cordis config snapshot delivered at plugin construction (the
//      composed plugin-patch / profile-patch layers),
//   4. the live re-read of the `dsh-tts:` section of the user settings
//      document (re-read on every call, so settings edits apply without a
//      restart; fields deleted from settings fall back to the layers below).
//
// Per-field provenance (FieldSource) is reported by the providers verb so a
// shadowed env value is never silent.

/** Where one config field's effective value comes from. */
export type FieldSource = 'default' | 'env' | 'cordis' | 'settings'

/** The per-field provenance of one provider profile. */
export interface ProviderSources {
  api: FieldSource
  baseURL: FieldSource
  apiKeyEnv: FieldSource
  headers: FieldSource
  models: FieldSource
  displayName: FieldSource
}

/** One resolved provider route (a TTS backend endpoint). */
export interface ProviderProfile {
  /** Canonical name (lowercase, hyphen separators). */
  name: string
  /** Display name (defaults to the canonical name). */
  displayName: string
  /** Wire protocol; the only v1 value is "openai-compatible". */
  api: string
  /** API base URL (OpenAI semantics, the path already includes /v1). */
  baseURL: string
  /** Credential reference (environment variable name) or null (no key). */
  apiKeyEnv: string | null
  /** Extra per-request headers (an explicit Authorization entry wins). */
  headers: Record<string, string>
  /** Declared model ids, or null when not declared (discover online). */
  models: string[] | null
  /** Per-field provenance. */
  sources: ProviderSources
}

/** The per-call resolved configuration snapshot. */
export interface TtsConfig {
  /** The default route name, or null. */
  defaultProvider: string | null
  /** The default route's provenance, or null. */
  defaultProviderSource: FieldSource | null
  /** All resolvable routes, in configuration order. */
  providers: ProviderProfile[]
  /** Whether any route is resolvable (false = the plugin is dormant). */
  configured: boolean
}

/** The config layer delivered by the cordis loader at construction. */
export interface DeliveredProfileConfig {
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models?: string[]
  displayName?: string
}

export interface DeliveredConfig {
  defaultProvider?: string
  providers?: Record<string, DeliveredProfileConfig>
}

/** Parameters of one synth call (everything the agent supplied explicitly). */
export interface SynthParams {
  input: string
  voice: string
  model?: string
  responseFormat?: string
  speed?: number
  language?: string
  out?: string
}

/** The successful synth result document (JSON-serialized to the caller). */
export interface SynthResult {
  out: string
  provider: string
  model: string
  voice: string
  response_format: string
  bytes: number
  sample_rate: number | null
  duration_s: number | null
  elapsed_s: number
  warnings?: string[]
}

/** One voice entry (fields beyond id/name pass through from the backend). */
export interface VoiceEntry {
  id: string
  name?: string
  [key: string]: unknown
}

/** Credentials state as reported by the providers verb (no values). */
export type CredentialState = 'ok' | 'missing' | 'not-configured'
