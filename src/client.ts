// dsh-tts HTTP adapter for OpenAI-compatible TTS backends.
//
// Wire contract (the plugin is protocol-bound, backend-agnostic). baseURL is
// the OpenAI-compatible base URL INCLUDING the /v1 prefix (the same shape as
// an LLM provider base URL, e.g. http://kokoro-tts:8880/v1); the OpenAI paths
// are appended to it verbatim:
//   POST {baseURL}/audio/speech    OpenAI-shaped body, binary response
//   GET  {baseURL}/audio/voices    voice listing (404 -> static OpenAI table)
//   GET  {baseURL}/models          model listing (ids)
// The root-level endpoints live outside the /v1 namespace and are addressed
// at the server root, derived by stripping a trailing /v1 from the baseURL
// (when the baseURL has no /v1 suffix it is used as the root):
//   GET  {serverRoot}/health       optional liveness probe (non-fatal)
//   POST {serverRoot}/dev/phonemize dev endpoint, {text, language}
//                                   (404/405 -> backend does not support it)
// Timeouts are constants, not config: synth 180s, probes 15s, phonemize 30s.
import type { ProviderProfile, SynthParams, VoiceEntry } from './types.js'
import { clip } from './util.js'
import { resolveCredential } from './credentials.js'

/** Synth timeout (text-to-speech is compute-heavy on CPU backends). */
export const SYNTH_TIMEOUT_MS = 180_000

/** Discovery/probe timeout (model listing, health). */
export const DISCOVERY_TIMEOUT_MS = 15_000

/** Phonemize timeout (dev endpoint, in-process compute). */
export const PHONEMIZE_TIMEOUT_MS = 30_000

/** Error for a non-2xx HTTP response (status + body snippet). */
export class TtsHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${clip(body, 400)}`)
    this.name = 'TtsHttpError'
    this.status = status
    this.body = body
  }
}

/**
 * The server root of a baseURL: trailing slashes and a trailing /v1 segment
 * are stripped, since the root-level endpoints (/health, /dev/phonemize)
 * live outside the /v1 namespace.
 * @param baseURL the configured base URL (e.g. http://host:8880/v1).
 * @returns the server root (e.g. http://host:8880); the input is returned
 *   unchanged when it has no /v1 suffix.
 */
export function serverRoot(baseURL: string): string {
  let root = baseURL.replace(/\/+$/, '')
  if (root.endsWith('/v1')) root = root.slice(0, -'/v1'.length)
  return root
}

/** Static voice table served when a backend lacks {baseURL}/audio/voices (404). */
export const OPENAI_STATIC_VOICES: VoiceEntry[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'nova', name: 'Nova' },
  { id: 'shimmer', name: 'Shimmer' },
]

/** The headers of an outbound request (after credential + profile merge). */
interface OutHeaders {
  [key: string]: string
}

/**
 * Build the outbound header set: the profile headers first, then the
 * credential-derived Authorization (an explicit Authorization header in the
 * profile wins over the credential reference).
 * @param profile the resolved provider.
 * @param dshHome the DSH home (credential file lookup).
 * @param env the env record (credential lookup).
 * @param requireCredential whether the call would be meaningless without the
 *   key (synth with an apiKeyEnv reference); when false, an unresolved
 *   reference degrades to the profile headers only.
 * @returns the merged header map.
 */
function buildHeaders(profile: ProviderProfile, dshHome: string, env: Record<string, string | undefined>, requireCredential: boolean): OutHeaders {
  const headers: OutHeaders = {}
  for (const [k, v] of Object.entries(profile.headers)) headers[k] = v
  if (profile.apiKeyEnv !== null) {
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
    if (!hasAuth) {
      const value = resolveCredential(profile.apiKeyEnv, dshHome, env)
      if (value === null) {
        if (requireCredential) {
          throw new Error(`credential missing: environment variable "${profile.apiKeyEnv}" is not set (provider ${profile.name}); set it in the environment or in ${dshHome}/.credentials.yaml`)
        }
      } else {
        headers['Authorization'] = `Bearer ${value}`
      }
    }
  }
  return headers
}

/**
 * One HTTP exchange against the provider (JSON in, JSON or binary out).
 * @param profile the resolved provider.
 * @param dshHome the DSH home (credential file lookup).
 * @param env the env record (credential lookup).
 * @param method the HTTP method.
 * @param path the path appended to the baseURL (starts with /).
 * @param timeoutMs the request timeout.
 * @param jsonBody the JSON request body (or undefined).
 * @param binary whether the response body is binary (Buffer) rather than JSON.
 * @param requireCredential see buildHeaders.
 * @param base optional base override for the path (root-level endpoints are
 *   addressed at the server root derived from the profile baseURL).
 * @returns the parsed JSON body, the raw Buffer, or null (204-style).
 */
async function request(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
  method: 'GET' | 'POST',
  path: string,
  timeoutMs: number,
  jsonBody: Record<string, unknown> | undefined,
  binary: boolean,
  requireCredential: boolean,
  base?: string,
): Promise<{ json: unknown; buf: Buffer | null; contentType: string | null }> {
  const url = (base ?? profile.baseURL).replace(/\/+$/, '') + path
  const headers = buildHeaders(profile, dshHome, env, requireCredential)
  if (jsonBody !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`request failed: ${method} ${url} -> ${clip(msg, 200)}`)
  }
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch {
      text = '(body unreadable)'
    }
    throw new TtsHttpError(res.status, text)
  }
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer())
    return { json: null, buf, contentType: res.headers.get('content-type') }
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { json, buf: null, contentType: res.headers.get('content-type') }
}

/**
 * Synthesize speech (POST {baseURL}/audio/speech, OpenAI-shaped body).
 * @param profile the resolved provider.
 * @param dshHome the DSH home.
 * @param env the env record.
 * @param params the synth parameters (model always set by the caller).
 * @returns the response bytes and content type.
 */
export async function synthesize(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
  params: SynthParams,
): Promise<{ buf: Buffer; contentType: string | null }> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: params.input,
    voice: params.voice,
    response_format: params.responseFormat,
  }
  if (params.speed !== undefined) body.speed = params.speed
  if (params.language !== undefined) body.language = params.language
  const r = await request(profile, dshHome, env, 'POST', '/audio/speech', SYNTH_TIMEOUT_MS, body, true, true)
  if (r.buf === null) throw new Error('synth: backend returned no body')
  return { buf: r.buf, contentType: r.contentType }
}

/** The voice listing verdict. */
export type VoicesResult =
  | { source: 'live'; voices: VoiceEntry[] }
  | { source: 'static'; voices: VoiceEntry[] }

/**
 * List voices (GET {baseURL}/audio/voices). The response list may be a bare
 * array, a {data: [...]} envelope, or a {voices: [...]} envelope (extractList).
 * A 404 (endpoint absent on the backend) falls back to the static OpenAI
 * table, marked source: static.
 * @param profile the resolved provider.
 * @param dshHome the DSH home.
 * @param env the env record.
 * @returns the voice list and its source.
 */
export async function listVoices(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
): Promise<VoicesResult> {
  let json: unknown
  try {
    const r = await request(profile, dshHome, env, 'GET', '/audio/voices', DISCOVERY_TIMEOUT_MS, undefined, false, false)
    json = r.json
  } catch (err) {
    if (err instanceof TtsHttpError && err.status === 404) {
      return { source: 'static', voices: OPENAI_STATIC_VOICES }
    }
    throw err
  }
  const list = extractList(json)
  const voices: VoiceEntry[] = []
  for (const item of list) {
    if (item !== null && typeof item === 'object' && 'id' in item) {
      const v = item as Record<string, unknown>
      const entry: VoiceEntry = { id: String(v.id) }
      if (typeof v.name === 'string') entry.name = v.name
      for (const [k, val] of Object.entries(v)) {
        if (k !== 'id' && k !== 'name') entry[k] = val
      }
      voices.push(entry)
    }
  }
  return { source: 'live', voices }
}

/**
 * List models (GET {baseURL}/models) as id strings.
 * @param profile the resolved provider.
 * @param dshHome the DSH home.
 * @param env the env record.
 * @returns the model ids.
 */
export async function listModels(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const r = await request(profile, dshHome, env, 'GET', '/models', DISCOVERY_TIMEOUT_MS, undefined, false, false)
  const list = extractList(r.json)
  const ids: string[] = []
  for (const item of list) {
    if (item !== null && typeof item === 'object' && 'id' in item) ids.push(String((item as Record<string, unknown>).id))
    else if (typeof item === 'string') ids.push(item)
  }
  return ids
}

/**
 * Probe the backend: GET {baseURL}/models plus an optional
 * GET {serverRoot}/health (a health failure never fails the probe).
 * @param profile the resolved provider.
 * @param dshHome the DSH home.
 * @param env the env record.
 * @returns reachability, model ids when listed, the health payload, and the
 *   first error hit (when unreachable).
 */
export async function probe(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
): Promise<{ reachable: boolean; error?: string; models?: string[]; health?: unknown }> {
  try {
    const models = await listModels(profile, dshHome, env)
    let health: unknown
    try {
      const r = await request(profile, dshHome, env, 'GET', '/health', DISCOVERY_TIMEOUT_MS, undefined, false, false, serverRoot(profile.baseURL))
      health = r.json
    } catch {
      health = undefined
    }
    return { reachable: true, models, health }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { reachable: false, error: clip(msg, 300) }
  }
}

/** The phonemize verdict. */
export type PhonemizeResult =
  | { supported: true; result: unknown }
  | { supported: false; error?: string }

/**
 * Call the dev phonemize endpoint (POST {serverRoot}/dev/phonemize, {text, language}).
 * A 404/405 means the backend does not implement the endpoint.
 * @param profile the resolved provider.
 * @param dshHome the DSH home.
 * @param env the env record.
 * @param text the text to phonemize.
 * @param language the language code (optional, verbatim).
 * @returns the phonemization result, or the unsupported verdict.
 */
export async function phonemize(
  profile: ProviderProfile,
  dshHome: string,
  env: Record<string, string | undefined>,
  text: string,
  language: string | undefined,
): Promise<PhonemizeResult> {
  const body: Record<string, unknown> = { text }
  if (language !== undefined) body.language = language
  try {
    const r = await request(profile, dshHome, env, 'POST', '/dev/phonemize', PHONEMIZE_TIMEOUT_MS, body, false, false, serverRoot(profile.baseURL))
    return { supported: true, result: r.json }
  } catch (err) {
    if (err instanceof TtsHttpError && (err.status === 404 || err.status === 405)) {
      return { supported: false }
    }
    throw err
  }
}

/**
 * Extract the element list from an OpenAI-shaped envelope ({data: [...]}) or a
 * {voices: [...]} envelope (some backends, e.g. FastKoko, answer
 * /audio/voices that way), or a bare array.
 * @param json the parsed response body.
 * @returns the element list (empty when the shape is unrecognized).
 */
export function extractList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json !== null && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    for (const key of ['data', 'voices'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
  }
  return []
}
