// dsh-tts package entry (public surface).
export { DshTtsPlugin } from './plugin.js'
export { default } from './plugin.js'
export { parseEnvContract, providerEnvVars, readSettingsSection, resolveConfig } from './config.js'
export type { EnvContract, SettingsSection } from './config.js'
export { readCredentialsFile, resolveCredential } from './credentials.js'
export {
  extractList,
  listModels,
  listVoices,
  OPENAI_STATIC_VOICES,
  phonemize,
  probe,
  serverRoot,
  synthesize,
  TtsHttpError,
} from './client.js'
export type { PhonemizeResult, VoicesResult } from './client.js'
export { verifyAudio } from './verify.js'
export type { AudioCheck } from './verify.js'
export type {
  CredentialState,
  DeliveredConfig,
  DeliveredProfileConfig,
  FieldSource,
  ProviderProfile,
  ProviderSources,
  SynthParams,
  SynthResult,
  TtsConfig,
  VoiceEntry,
} from './types.js'
export { defaultOutRoot, registerTool, resolveOutPath, VERBS } from './tool.js'
export { canonicalName, dshHomeFromEnv, fileSafe, PLUGIN_NAME, PROVIDER_NAME_RE } from './util.js'
