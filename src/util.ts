// dsh-tts shared utilities: plugin identifier, DSH home resolution, and
// low-level helpers (error message extraction, plain-object check, name
// normalization, file-name sanitizing).
//
// Pure Node dependencies, no framework packages; safe to import from selftest.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identifier (registered name, logger tag, prompt section name). */
export const PLUGIN_NAME = 'dsh-tts'

/**
 * The package root of the running code (src development state / lib deployment
 * state are isomorphic).
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Resolve the DSH home directory: the DSH_HOME environment variable, falling
 * back to the conventional location under the user home.
 * @returns absolute DSH home path.
 */
export function dshHomeFromEnv(env: Record<string, string | undefined>): string {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** Error message extraction (catch variables are unknown under strict). */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Plain-object check: an object that is neither null nor an array. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Normalize a provider name for cross-layer matching: lowercase, and the
 * underscore and hyphen are treated as the same separator (env variable names
 * cannot carry hyphens, so the same provider is spelled KOKORO_LOCAL in the
 * environment and kokoro-local in config layers).
 * @param name the provider name in any layer spelling.
 * @returns canonical name (lowercase, hyphen separators).
 */
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-')
}

/**
 * Provider name charset: lowercase start, 1-64 chars (same convention as
 * dsh-timer job ids and dsh-ntfy channel names).
 */
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Sanitize a value for use as a single file-name component: anything outside
 * the safe set becomes an underscore (voice ids pass through unchanged).
 * @param value the raw value (typically a voice id).
 * @returns a file-name-safe form.
 */
export function fileSafe(value: string): string {
  const out = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return out.length > 0 ? out : '_'
}

/** Truncate a string to a byte budget for error reporting. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
