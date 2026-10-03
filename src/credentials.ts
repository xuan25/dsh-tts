// dsh-tts credential resolution: an apiKeyEnv reference (an environment
// variable name) resolves to the key value through two sources, in order:
// the process environment, then the managed credentials document
// (<dshHome>/.credentials.yaml, a flat mapping of variable names to values).
// The key value never enters any config document; only the reference name is
// configurable.
import fs from 'node:fs'
import * as YAML from 'yaml'
import { isPlainObject } from './util.js'

/**
 * Resolve a credential reference to its value.
 * @param name the environment variable name (the apiKeyEnv reference).
 * @param dshHome the DSH home (the managed credentials document lives there).
 * @param env the env record to search first (process.env in production).
 * @returns the key value, or null when no source carries it.
 */
export function resolveCredential(
  name: string,
  dshHome: string,
  env: Record<string, string | undefined>,
): string | null {
  const fromEnv = env[name]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const fromFile = readCredentialsFile(dshHome)
  if (fromFile === null) return null
  const v = fromFile[name]
  if (typeof v === 'string' && v.length > 0) return v
  return null
}

/**
 * Read the managed credentials document (a flat string mapping). A missing or
 * unparseable file yields null (credential references then resolve from the
 * environment only).
 * @param dshHome the DSH home directory.
 * @returns the parsed mapping, or null.
 */
export function readCredentialsFile(dshHome: string): Record<string, string> | null {
  let text: string
  try {
    text = fs.readFileSync(`${dshHome}/.credentials.yaml`, 'utf8')
  } catch {
    return null
  }
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(doc)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}
