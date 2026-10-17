// dsh-tts selftest: in-process verification of the shipped plugin.
//   - config resolution: the env contract, the delivered config layer, the live
//     settings section, the precedence chain, drop rules, provenance
//   - credential resolution (process env, managed credentials file)
//   - container verification (RIFF walk, placeholder-size defect, magics)
//   - the HTTP adapter against an in-process stub (request shapes, error
//     shapes, the static voice fallback, discovery, probes, phonemize)
//   - the tts tool behavior through a fake cordis context (verb matrix,
//     provider/model resolution, output placement)
//   - the plugin entry point (class wiring, the bundled skill, the delivered
//     config schema)
//   - shipped-file gates: manifest sanity, strict ASCII (including the skill
//     tree)
// Run: pnpm run selftest   (after pnpm run build)
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DshTtsPlugin,
  OPENAI_STATIC_VOICES,
  extractList,
  listModels,
  listVoices,
  phonemize,
  probe,
  readCredentialsFile,
  registerTool,
  resolveConfig,
  resolveCredential,
  resolveOutPath,
  serverRoot,
  synthesize,
  TtsHttpError,
  VERBS,
  verifyAudio,
} from '../lib/index.js'

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TTS_TEST_KEY_NAME = 'TTS_TEST_KEY'
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u00b5\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]/

let passed = 0
const failures = []
function ok(name, cond) {
  if (cond) passed++
  else failures.push(name)
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${label}: expected ${e}, got ${a}`)
}

// -- fixtures -----------------------------------------------------------------

/** Build a RIFF/WAVE container. placeholder sets both the RIFF header size
 *  and the data chunk size to the 0xFFFFFFFF defect; the two placeholder
 *  flags can also be set independently. */
function makeWav({ sampleRate = 24000, channels = 1, bits = 16, samples = 480, placeholder = false, placeholderHeader = placeholder, placeholderData = placeholder, placeholderValue = 0xffffffff } = {}) {
  const bytesPerSample = bits / 8
  const data = Buffer.alloc(samples * channels * bytesPerSample)
  const bps = sampleRate * channels * bytesPerSample
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(bps, 8)
  fmt.writeUInt16LE(channels * bytesPerSample, 12)
  fmt.writeUInt16LE(bits, 14)
  const headerSize = 4 + 4 + 8 + 16 + 8 + data.length
  const riff = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WAVE', 'ascii'),
    Buffer.from('fmt ', 'ascii'),
    Buffer.alloc(4),
    fmt,
    Buffer.from('data', 'ascii'),
    Buffer.alloc(4),
    data,
  ])
  riff.writeUInt32LE(placeholderHeader ? placeholderValue : headerSize, 4)
  riff.writeUInt32LE(16, 16)
  riff.writeUInt32LE(placeholderData ? placeholderValue : data.length, 40)
  return riff
}

/** Build a well-formed RIFF/WAVE with a valid LIST chunk before the data
 *  chunk (the RIFF + fmt + LIST + data layout the verification backends emit). */
function makeListWav() {
  const data = Buffer.alloc(960)
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(24000, 4)
  fmt.writeUInt32LE(48000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const riff = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WAVE', 'ascii'),
    Buffer.from('fmt ', 'ascii'),
    Buffer.alloc(4),
    fmt,
    Buffer.from('LIST', 'ascii'),
    Buffer.alloc(4),
    Buffer.alloc(24),
    Buffer.from('data', 'ascii'),
    Buffer.alloc(4),
    data,
  ])
  riff.writeUInt32LE(riff.length - 8, 4)
  riff.writeUInt32LE(16, 16)
  riff.writeUInt32LE(24, 40)
  riff.writeUInt32LE(960, 72)
  return riff
}

/** Build a RIFF/WAVE whose chunk table is broken: a LIST chunk declares a
 *  placeholder size before the data chunk, so the walk cannot reach it. */
function makeBrokenWav() {
  const data = Buffer.alloc(480)
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(24000, 4)
  fmt.writeUInt32LE(48000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.alloc(4), Buffer.alloc(24)])
  list.writeUInt32LE(0xffffffff, 4)
  const dataChunk = Buffer.concat([Buffer.from('data', 'ascii'), Buffer.alloc(4), data])
  dataChunk.writeUInt32LE(0xffffffff, 8)
  const riff = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WAVE', 'ascii'),
    Buffer.from('fmt ', 'ascii'),
    Buffer.alloc(4),
    fmt,
    list,
    dataChunk,
  ])
  riff.writeUInt32LE(16, 16) // fmt chunk size
  return riff
}

const MP3_FIXTURE = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22])
const AAC_FIXTURE = Buffer.from([0xff, 0xf1, 0x50, 0x00])
const FLAC_FIXTURE = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(16)])
const OPUS_FIXTURE = Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(16)])
const PCM_FIXTURE = Buffer.from('rawrawrawraw')
const GARBAGE = Buffer.from('this is definitely not a wave file', 'ascii')

const EMPTY_ENV = {}
const WARN_SINK = (collect) => (msg) => {
  if (collect !== null) collect.push(msg)
}

/** Temp DSH home helper (empty by default; callers add settings/credentials). */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-selftest-'))
}

// -- config resolution --------------------------------------------------------

{
  const home = makeHome()
  const env = {
    TTS_DEFAULT_PROVIDER: 'kokoro-local',
    TTS_PROVIDER_KOKORO_LOCAL_BASEURL: 'http://a:1/v1',
    TTS_PROVIDER_KOKORO_LOCAL_APIKEYENV: 'K1',
    TTS_PROVIDER_KOKORO_LOCAL_MODELS: 'm1, m2',
    TTS_PROVIDER_KOKORO_LOCAL_HEADERS: '{"Authorization":"Bearer not-needed","X-Extra":"1"}',
    TTS_PROVIDER_KOKORO_LOCAL_DISPLAYNAME: 'Local',
  }
  const warns = []
  const cfg = resolveConfig(undefined, env, home, WARN_SINK(warns))
  ok('config(env): one provider survives', cfg.configured && cfg.providers.length === 1)
  const p = cfg.providers[0]
  eq('config(env): name normalized', p.name, 'kokoro-local')
  eq('config(env): baseURL from env', p.baseURL, 'http://a:1/v1')
  eq('config(env): models split+trimmed', p.models, ['m1', 'm2'])
  eq('config(env): headers parsed', p.headers, { Authorization: 'Bearer not-needed', 'X-Extra': '1' })
  eq('config(env): apiKeyEnv', p.apiKeyEnv, 'K1')
  eq('config(env): displayName', p.displayName, 'Local')
  eq('config(env): api default', p.api, 'openai-compatible')
  eq('config(env): sources', p.sources, {
    api: 'default',
    baseURL: 'env',
    apiKeyEnv: 'env',
    headers: 'env',
    models: 'env',
    displayName: 'env',
  })
  eq('config(env): default provider', cfg.defaultProvider, 'kokoro-local')
  eq('config(env): default source', cfg.defaultProviderSource, 'env')
  eq('config(env): no warnings', warns, [])

  // delivered-only layer
  const warns2 = []
  const cfg2 = resolveConfig({ defaultProvider: 'p1', providers: { p1: { baseURL: 'http://b', apiKeyEnv: 'K2' } } }, EMPTY_ENV, home, WARN_SINK(warns2))
  eq('config(cordis): one provider', cfg2.providers.length, 1)
  eq('config(cordis): api default', cfg2.providers[0].api, 'openai-compatible')
  eq('config(cordis): baseURL source', cfg2.providers[0].sources.baseURL, 'cordis')
  eq('config(cordis): apiKeyEnv source', cfg2.providers[0].sources.apiKeyEnv, 'cordis')
  eq('config(cordis): models absent', cfg2.providers[0].models, null)
  eq('config(cordis): models source', cfg2.providers[0].sources.models, 'default')
  eq('config(cordis): default', cfg2.defaultProvider, 'p1')
  eq('config(cordis): default source', cfg2.defaultProviderSource, 'cordis')
  eq('config(cordis): no warnings', warns2, [])

  // merge across layers (env + cordis spell the same provider differently)
  const warns3 = []
  const cfg3 = resolveConfig(
    { providers: { 'kokoro-local': { apiKeyEnv: 'K2', models: ['only'] } } },
    { TTS_PROVIDER_KOKORO_LOCAL_BASEURL: 'http://a:1/v1' },
    home,
    WARN_SINK(warns3),
  )
  eq('config(merge): single merged provider', cfg3.providers.length, 1)
  eq('config(merge): env baseURL', cfg3.providers[0].sources.baseURL, 'env')
  eq('config(merge): cordis apiKeyEnv', cfg3.providers[0].apiKeyEnv, 'K2')
  eq('config(merge): cordis models', cfg3.providers[0].models, ['only'])
  eq('config(merge): no warnings', warns3, [])

  // settings layer beats cordis and env
  const home4 = makeHome()
  fs.writeFileSync(
    path.join(home4, 'settings.yaml'),
    [
      'other: 1',
      'dsh-tts:',
      '  defaultProvider: kokoro-local',
      '  providers:',
      '    kokoro-local:',
      '      baseURL: http://settings:2/v1',
      '      displayName: Settings Name',
      '',
    ].join('\n'),
  )
  const warns4 = []
  const cfg4 = resolveConfig(
    { providers: { 'kokoro-local': { baseURL: 'http://cordis:1/v1', apiKeyEnv: 'K' } } },
    { TTS_PROVIDER_KOKORO_LOCAL_BASEURL: 'http://env:1/v1' },
    home4,
    WARN_SINK(warns4),
  )
  eq('config(settings): settings baseURL wins', cfg4.providers[0].baseURL, 'http://settings:2/v1')
  eq('config(settings): source settings', cfg4.providers[0].sources.baseURL, 'settings')
  eq('config(settings): displayName wins', cfg4.providers[0].displayName, 'Settings Name')
  eq('config(settings): apiKeyEnv falls through to cordis', cfg4.providers[0].apiKeyEnv, 'K')
  eq('config(settings): default from settings', cfg4.defaultProviderSource, 'settings')
  eq('config(settings): no warnings', warns4, [])

  // a settings file without the section leaves the other layers untouched
  const home5 = makeHome()
  fs.writeFileSync(path.join(home5, 'settings.yaml'), 'other: 1\n')
  const cfg5 = resolveConfig({ providers: { p1: { baseURL: 'http://b' } } }, EMPTY_ENV, home5, WARN_SINK(null))
  eq('config(settings absent): cordis source kept', cfg5.providers[0].sources.baseURL, 'cordis')

  // a malformed settings file is ignored with a warning
  const home6 = makeHome()
  fs.writeFileSync(path.join(home6, 'settings.yaml'), '{{{ not yaml\n')
  const warns6 = []
  const cfg6 = resolveConfig({ providers: { p1: { baseURL: 'http://b' } } }, EMPTY_ENV, home6, WARN_SINK(warns6))
  eq('config(settings malformed): cordis source kept', cfg6.providers[0].sources.baseURL, 'cordis')
  ok('config(settings malformed): one warning', warns6.length === 1 && warns6[0].includes('could not parse'))

  // drop rules
  const warns7 = []
  const cfg7 = resolveConfig(
    { providers: { nobase: {}, grpc: { baseURL: 'http://g', api: 'grpc' }, good: { baseURL: 'http://g' } }, defaultProvider: 'nobase' },
    EMPTY_ENV,
    home,
    WARN_SINK(warns7),
  )
  eq('config(drop): only the good provider survives', cfg7.providers.map((p) => p.name), ['good'])
  ok('config(drop): three warnings (no baseURL, unknown api, stale default)', warns7.length === 3)
  eq('config(drop): default to a dropped provider is ignored', cfg7.defaultProvider, null)

  const warns8 = []
  const cfg8 = resolveConfig({ defaultProvider: '9bad' }, { TTS_PROVIDER_A_BASEURL: 'http://a' }, home, WARN_SINK(warns8))
  eq('config(drop): invalid default name is ignored', cfg8.defaultProvider, null)
  ok('config(drop): invalid name warning', warns8.length === 1 && warns8[0].includes('not a valid name'))

  // provider names that fail the name contract are dropped (env and settings layers)
  const warnsA = []
  const cfgA = resolveConfig(undefined, { TTS_PROVIDER_9LIVES_BASEURL: 'http://x' }, home, WARN_SINK(warnsA))
  eq('config(name): digit-leading env name dropped', cfgA.providers.length, 0)
  ok('config(name): drop warning', warnsA.length === 1 && warnsA[0].includes('not a valid name'))
  const homeB = makeHome()
  fs.writeFileSync(
    path.join(homeB, 'settings.yaml'),
    ['dsh-tts:', '  providers:', '    9bad:', '      baseURL: http://x', '    good:', '      baseURL: http://y', ''].join('\n'),
  )
  const warnsB = []
  const cfgB = resolveConfig(undefined, EMPTY_ENV, homeB, WARN_SINK(warnsB))
  eq('config(name): invalid settings name dropped', cfgB.providers.map((p) => p.name), ['good'])
  ok('config(name): one drop warning', warnsB.length === 1)
  fs.rmSync(homeB, { recursive: true, force: true })

  // unparseable env headers drop the field, keep the provider
  const warns9 = []
  const cfg9 = resolveConfig(
    undefined,
    { TTS_PROVIDER_A_BASEURL: 'http://a', TTS_PROVIDER_A_HEADERS: 'not json' },
    home,
    WARN_SINK(warns9),
  )
  eq('config(headers): provider survives', cfg9.providers.length, 1)
  eq('config(headers): field dropped to default', cfg9.providers[0].sources.headers, 'default')
  eq('config(headers): empty headers', cfg9.providers[0].headers, {})
  ok('config(headers): one warning', warns9.length === 1)
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(home4, { recursive: true, force: true })
  fs.rmSync(home5, { recursive: true, force: true })
  fs.rmSync(home6, { recursive: true, force: true })
}

// -- credentials --------------------------------------------------------------

{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'TTS_FILE_KEY: fileval\nEMPTY_KEY: ""\n')
  const file = readCredentialsFile(home)
  eq('cred: file mapping', file, { TTS_FILE_KEY: 'fileval', EMPTY_KEY: '' })
  eq('cred: env wins', resolveCredential('TTS_FILE_KEY', home, { TTS_FILE_KEY: 'envval' }), 'envval')
  eq('cred: file fallback', resolveCredential('TTS_FILE_KEY', home, {}), 'fileval')
  eq('cred: empty value is null', resolveCredential('EMPTY_KEY', home, {}), null)
  eq('cred: missing reference is null', resolveCredential('NOPE', home, {}), null)
  eq('cred: missing file is null', readCredentialsFile(path.join(home, 'nope')), null)
  fs.rmSync(home, { recursive: true, force: true })
}

// -- container verification ---------------------------------------------------

{
  const good = verifyAudio('wav', makeWav())
  eq('verify(wav): rate', good.sampleRate, 24000)
  eq('verify(wav): duration', good.durationS, 0.02)
  eq('verify(wav): clean', good.warnings, [])
  ok('verify(wav): no error', good.error === undefined)

  const ph = verifyAudio('wav', makeWav({ placeholder: true }))
  ok('verify(wav placeholder): one warning', ph.warnings.length === 1 && ph.warnings[0].includes('placeholder'))
  eq('verify(wav placeholder): duration from actual payload', ph.durationS, 0.02)
  ok('verify(wav placeholder): no error', ph.error === undefined)

  // header-only placeholder: only the RIFF header size is a placeholder
  const hdr = verifyAudio('wav', makeWav({ placeholderHeader: true }))
  ok('verify(wav header placeholder): warning names the header size', hdr.error === undefined && hdr.warnings.length === 1 && hdr.warnings[0].includes('RIFF header size'))
  eq('verify(wav header placeholder): duration intact', hdr.durationS, 0.02)

  // broken chunk table: a placeholder-sized non-data chunk before the data chunk
  const br = verifyAudio('wav', makeBrokenWav())
  ok('verify(wav broken table): tolerated with a warning', br.error === undefined && br.sampleRate === 24000 && br.warnings.length === 1 && br.warnings[0].includes('no data chunk'))
  // payload = from the end of the walk (the LIST header) to the buffer end:
  // LIST header (8) + LIST body (24) + data chunk header (8) + samples (480) = 520
  ok('verify(wav broken table): duration from the walk end', br.durationS !== null && br.durationS > 520 / 48000 - 1e-9 && br.durationS < 520 / 48000 + 1e-9)

  // well-formed RIFF + fmt + LIST + data (the layout the verification backends emit)
  const lw = verifyAudio('wav', makeListWav())
  ok('verify(wav fmt+LIST+data): clean', lw.error === undefined && lw.warnings.length === 0 && lw.sampleRate === 24000)
  eq('verify(wav fmt+LIST+data): duration', lw.durationS, 0.02)

  // 0x7FFFFFFF variant of the placeholder defect
  const ph7 = verifyAudio('wav', makeWav({ placeholder: true, placeholderValue: 0x7fffffff }))
  ok('verify(wav 0x7fffffff placeholder): warning still reported', ph7.error === undefined && ph7.warnings.length === 1 && ph7.warnings[0].includes('placeholder'))

  // RIFF/WAVE magic but no sound fmt chunk: a distinct error, not "not a RIFF"
  const nofmt = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVE', 'ascii'), Buffer.alloc(16)])
  ok('verify(wav no fmt): error names the fmt chunk', verifyAudio('wav', nofmt).error.includes('without a valid fmt chunk'))

  const bad = verifyAudio('wav', GARBAGE)
  ok('verify(wav garbage): error set', bad.error !== undefined && bad.error.includes('not a RIFF/WAVE'))

  eq('verify(mp3): clean', verifyAudio('mp3', MP3_FIXTURE).warnings, [])
  ok('verify(mp3 garbage): error', verifyAudio('mp3', GARBAGE).error !== undefined)
  eq('verify(flac): clean', verifyAudio('flac', FLAC_FIXTURE).warnings, [])
  ok('verify(flac garbage): error', verifyAudio('flac', GARBAGE).error !== undefined)
  eq('verify(aac): clean', verifyAudio('aac', AAC_FIXTURE).warnings, [])
  ok('verify(aac garbage): error', verifyAudio('aac', GARBAGE).error !== undefined)
  eq('verify(opus): clean', verifyAudio('opus', OPUS_FIXTURE).warnings, [])
  ok('verify(opus garbage): error', verifyAudio('opus', GARBAGE).error !== undefined)

  const pcm = verifyAudio('pcm', PCM_FIXTURE)
  eq('verify(pcm): nulls', [pcm.sampleRate, pcm.durationS], [null, null])
  eq('verify(pcm): clean', pcm.warnings, [])

  const unk = verifyAudio('oga', Buffer.alloc(4))
  eq('verify(unknown): warning', unk.warnings.length, 1)
  ok('verify(unknown): warning names the format', unk.warnings[0].includes('oga'))
}

// -- HTTP adapter against the in-process stub ---------------------------------

const behaviors = { speech: 'good-wav', voices: 'list', models: 'envelope', health: 'ok', phonemize: 'ok' }
let lastSpeech = null

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = req.url ?? '/'
    if (req.method === 'POST' && url === '/v1/audio/speech') {
      lastSpeech = { headers: req.headers, body: body === '' ? null : JSON.parse(body) }
      const send = (code, head, data) => {
        res.writeHead(code, head)
        res.end(data)
      }
      if (behaviors.speech === '400') {
        send(400, { 'content-type': 'application/json' }, JSON.stringify({ error: { message: "voice 'zz' was not found" } }))
        return
      }
      const payload =
        behaviors.speech === 'mp3' ? MP3_FIXTURE : behaviors.speech === 'bad-wav' ? GARBAGE : behaviors.speech === 'placeholder-wav' ? makeWav({ placeholder: true }) : makeWav()
      send(200, { 'content-type': behaviors.speech === 'mp3' ? 'audio/mpeg' : 'audio/wav' }, payload)
      return
    }
    if (req.method === 'GET' && url === '/v1/audio/voices') {
      if (behaviors.voices === '404') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const voiceItems = [
        { id: 'zf_xiaoxiao', name: 'Xiaoxiao', gender: 'female', quality: 'A' },
        { id: 'am_michael', name: 'Michael', gender: 'male', quality: 'A' },
        { id: 'zf_yunjian', name: 'Yunjian', gender: 'female', quality: 'A' },
      ]
      const body = behaviors.voices === 'voices-key' ? { voices: voiceItems } : voiceItems
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    if (req.method === 'GET' && url === '/v1/models') {
      if (behaviors.models === '404') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (behaviors.models === 'bare') res.end(JSON.stringify([{ id: 'kokoro-v1' }, { id: 'v2' }]))
      else if (behaviors.models === 'single') res.end(JSON.stringify({ data: [{ id: 'kokoro-v1' }] }))
      else res.end(JSON.stringify({ data: [{ id: 'kokoro-v1' }, { id: 'v2' }] }))
      return
    }
    if (req.method === 'GET' && url === '/health') {
      if (behaviors.health === '404') {
        res.writeHead(404)
        res.end('')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'POST' && url === '/dev/phonemize') {
      if (behaviors.phonemize === '404') {
        res.writeHead(404)
        res.end('')
        return
      }
      lastSpeech = { headers: req.headers, body: body === '' ? null : JSON.parse(body) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ phonemes: JSON.parse(body).text.split('') }))
      return
    }
    res.writeHead(404)
    res.end('no route')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
// baseURL includes the /v1 prefix (the LLM-provider base URL shape); the
// root-level endpoints are addressed at the server root (trailing /v1
// stripped), matching the routes below.
const BASE = `http://127.0.0.1:${server.address().port}/v1`

function makeProfile(over = {}) {
  return {
    name: 'stub',
    displayName: 'stub',
    api: 'openai-compatible',
    baseURL: BASE,
    apiKeyEnv: TTS_TEST_KEY_NAME,
    headers: {},
    models: null,
    sources: { api: 'default', baseURL: 'default', apiKeyEnv: 'default', headers: 'default', models: 'default', displayName: 'default' },
    ...over,
  }
}
const CLIENT_ENV = { [TTS_TEST_KEY_NAME]: 'testkey' }

{
  // synth happy path: request shape, credential header, container
  const r = await synthesize(makeProfile(), '/nonexistent', CLIENT_ENV, { input: 'hi', voice: 'zf_xiaoxiao', model: 'm', responseFormat: 'wav', speed: 1.2, language: 'zh' })
  eq('client(synth): body shape', lastSpeech.body, { model: 'm', input: 'hi', voice: 'zf_xiaoxiao', response_format: 'wav', speed: 1.2, language: 'zh' })
  eq('client(synth): credential header', lastSpeech.headers.authorization, 'Bearer testkey')
  ok('client(synth): content-type header', lastSpeech.headers['content-type'] === 'application/json')
  ok('client(synth): wav payload', r.buf.toString('ascii', 0, 4) === 'RIFF')
  eq('client(synth): content type', r.contentType, 'audio/wav')

  // optional params stay out of the body when absent
  await synthesize(makeProfile(), '/nonexistent', CLIENT_ENV, { input: 'hi', voice: 'v', model: 'm', responseFormat: 'mp3' })
  eq('client(synth): no optional params', lastSpeech.body, { model: 'm', input: 'hi', voice: 'v', response_format: 'mp3' })

  // backend 4xx surfaces status + body
  behaviors.speech = '400'
  let caught = null
  try {
    await synthesize(makeProfile(), '/nonexistent', CLIENT_ENV, { input: 'hi', voice: 'zz', model: 'm', responseFormat: 'wav' })
  } catch (e) {
    caught = e
  }
  ok('client(synth 400): TtsHttpError', caught instanceof TtsHttpError)
  eq('client(synth 400): status', caught === null ? null : caught.status, 400)
  ok('client(synth 400): message carries the backend text', caught !== null && caught.message.includes("voice 'zz'"))
  behaviors.speech = 'good-wav'

  // missing credential on a credentialed synth is an error
  const p2 = makeProfile({ apiKeyEnv: 'NOPE_KEY' })
  let miss = null
  try {
    await synthesize(p2, '/nonexistent', {}, { input: 'hi', voice: 'v', model: 'm', responseFormat: 'wav' })
  } catch (e) {
    miss = e
  }
  ok('client(credential): missing key errors', miss !== null && miss.message.includes('credential missing') && miss.message.includes('NOPE_KEY'))

  // an explicit Authorization header wins over the credential reference
  const p3 = makeProfile({ apiKeyEnv: 'NOPE_KEY', headers: { Authorization: 'Bearer explicit' } })
  const r3 = await synthesize(p3, '/nonexistent', {}, { input: 'hi', voice: 'v', model: 'm', responseFormat: 'wav' })
  eq('client(credential): explicit header wins', lastSpeech.headers.authorization, 'Bearer explicit')
  ok('client(credential): payload ok', r3.buf.length > 0)

  // voices: live list (fields pass through) and the static fallback on 404
  behaviors.voices = 'list'
  const v1 = await listVoices(makeProfile(), '/nonexistent', CLIENT_ENV)
  eq('client(voices): source live', v1.source, 'live')
  eq('client(voices): count', v1.voices.length, 3)
  eq('client(voices): pass-through field', v1.voices[0].quality, 'A')
  behaviors.voices = 'voices-key'
  const v1b = await listVoices(makeProfile(), '/nonexistent', CLIENT_ENV)
  eq('client(voices): voices-key source', v1b.source, 'live')
  eq('client(voices): voices-key ids', v1b.voices.map((v) => v.id), ['zf_xiaoxiao', 'am_michael', 'zf_yunjian'])
  behaviors.voices = '404'
  const v2 = await listVoices(makeProfile(), '/nonexistent', CLIENT_ENV)
  eq('client(voices): static source', v2.source, 'static')
  eq('client(voices): static table', v2.voices.map((v) => v.id), OPENAI_STATIC_VOICES.map((v) => v.id))

  // models: envelope and bare shapes
  behaviors.models = 'envelope'
  eq('client(models): envelope', await listModels(makeProfile(), '/nonexistent', CLIENT_ENV), ['kokoro-v1', 'v2'])
  behaviors.models = 'bare'
  eq('client(models): bare', await listModels(makeProfile(), '/nonexistent', CLIENT_ENV), ['kokoro-v1', 'v2'])
  eq('client(extractList): unrecognized shape', extractList({ nope: 1 }), [])
  eq('client(extractList): voices envelope', extractList({ voices: [{ id: 'a' }, { id: 'b' }] }), [{ id: 'a' }, { id: 'b' }])
  eq('client(extractList): data wins over voices', extractList({ data: [1], voices: [2] }), [1])

  // probe: with health, health-absent, and unreachable
  behaviors.models = 'envelope'
  behaviors.health = 'ok'
  const s1 = await probe(makeProfile(), '/nonexistent', CLIENT_ENV)
  eq('client(probe): reachable', s1.reachable, true)
  eq('client(probe): models', s1.models, ['kokoro-v1', 'v2'])
  eq('client(probe): health', s1.health, { status: 'ok' })
  behaviors.health = '404'
  const s2 = await probe(makeProfile(), '/nonexistent', CLIENT_ENV)
  eq('client(probe): health absent tolerated', s2.health, undefined)
  behaviors.health = 'ok'
  const s3 = await probe(makeProfile({ baseURL: 'http://127.0.0.1:1' }), '/nonexistent', CLIENT_ENV)
  eq('client(probe): unreachable', s3.reachable, false)
  ok('client(probe): error message present', s3.error !== undefined && s3.error.length > 0)

  // serverRoot: the root-level endpoints are addressed with the trailing /v1 stripped
  eq('client(serverRoot): strips trailing /v1', serverRoot('http://a:1/v1'), 'http://a:1')
  eq('client(serverRoot): /v1 plus trailing slash', serverRoot('http://a:1/v1/'), 'http://a:1')
  eq('client(serverRoot): root base unchanged', serverRoot('http://a:1'), 'http://a:1')

  // phonemize: supported, and the 404 fallback
  behaviors.phonemize = 'ok'
  const ph1 = await phonemize(makeProfile(), '/nonexistent', CLIENT_ENV, 'hello', 'en')
  eq('client(phonemize): supported', ph1.supported, true)
  eq('client(phonemize): result', ph1.result, { phonemes: ['h', 'e', 'l', 'l', 'o'] })
  eq('client(phonemize): request shape', lastSpeech.body, { text: 'hello', language: 'en' })
  behaviors.phonemize = '404'
  const ph2 = await phonemize(makeProfile(), '/nonexistent', CLIENT_ENV, 'hello')
  eq('client(phonemize): unsupported', ph2, { supported: false })
}

// -- tool behavior through a fake cordis context ------------------------------

{
  const home = makeHome()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-tool-'))
  const K = 'TTS_PROVIDER_KOKORO_LOCAL_BASEURL'
  const O = 'TTS_PROVIDER_OTHER_BASEURL'
  const D = 'TTS_DEFAULT_PROVIDER'
  const MODELS_K = 'TTS_PROVIDER_KOKORO_LOCAL_MODELS'
  const MODELS_O = 'TTS_PROVIDER_OTHER_MODELS'
  const KEYREF_K = 'TTS_PROVIDER_KOKORO_LOCAL_APIKEYENV'
  const touched = [K, O, D, MODELS_K, MODELS_O, KEYREF_K, TTS_TEST_KEY_NAME]
  for (const k of touched) delete process.env[k]

  const savedHome = process.env.DSH_HOME ?? null
  const savedKey = process.env[TTS_TEST_KEY_NAME] ?? null
  process.env.DSH_HOME = home
  process.env[TTS_TEST_KEY_NAME] = 'testkey'

  const captured = []
  const ctx = {
    logger: () => ({ warn: () => {} }),
    tools: {
      register: (def) => {
        captured.push(def)
        return () => {}
      },
    },
    systemPrompt: { section: () => {} },
  }
  registerTool(ctx, undefined, () => {})
  const tool = captured[0]
  ok('tool: registered exactly once', captured.length === 1)
  eq('tool: name', tool.name, 'tts')
  eq('tool: verbs', tool.parameters.properties.verb.enum, [...VERBS])
  ok('tool: verb required', (tool.parameters.required ?? []).includes('verb') === true)

  const run = async (args) => JSON.parse(await tool.execute(args))

  // dormant state: providers works, the rest report TTS_NOT_CONFIGURED
  const r0 = await run({ verb: 'providers' })
  eq('tool(dormant): providers', r0, { configured: false, default: null, providers: [] })
  eq('tool(dormant): synth blocked', (await run({ verb: 'synth', input: 'x', voice: 'v' })).error, 'TTS_NOT_CONFIGURED')
  eq('tool(dormant): voices blocked', (await run({ verb: 'voices' })).error, 'TTS_NOT_CONFIGURED')

  // single provider via env; synth happy path (explicit file out)
  process.env[K] = BASE
  process.env[MODELS_K] = 'kokoro-v1'
  const outFile = path.join(outDir, 'one.wav')
  behaviors.speech = 'good-wav'
  const s1 = await run({ verb: 'synth', input: 'hello', voice: 'zf_xiaoxiao', out: outFile })
  eq('tool(synth): out', s1.out, outFile)
  eq('tool(synth): model auto from single declared', s1.model, 'kokoro-v1')
  eq('tool(synth): sample rate', s1.sample_rate, 24000)
  eq('tool(synth): duration', s1.duration_s, 0.02)
  ok('tool(synth): no warnings key', s1.warnings === undefined)
  ok('tool(synth): file on disk is RIFF', fs.readFileSync(outFile).toString('ascii', 0, 4) === 'RIFF')
  ok('tool(synth): elapsed reported', typeof s1.elapsed_s === 'number' && s1.elapsed_s >= 0)

  // placeholder container: warning, playable payload, file kept
  behaviors.speech = 'placeholder-wav'
  const s2 = await run({ verb: 'synth', input: 'hi', voice: 'zf_xiaoxiao', out: path.join(outDir, 'ph.wav') })
  ok('tool(synth placeholder): warning reported', Array.isArray(s2.warnings) && s2.warnings.some((w) => w.includes('placeholder')))
  eq('tool(synth placeholder): duration computed', s2.duration_s, 0.02)
  ok('tool(synth placeholder): file kept', fs.existsSync(s2.out))

  // container mismatch: error, file kept at out
  behaviors.speech = 'bad-wav'
  const s3 = await run({ verb: 'synth', input: 'hi', voice: 'zf_xiaoxiao', out: path.join(outDir, 'bad.wav') })
  ok('tool(synth mismatch): error set', s3.error !== undefined && s3.error.includes('not a RIFF/WAVE'))
  eq('tool(synth mismatch): out reported', typeof s3.out, 'string')
  ok('tool(synth mismatch): file kept', fs.existsSync(s3.out))

  // backend 4xx: backend text surfaced, no file written
  behaviors.speech = '400'
  const noFile = path.join(outDir, 'never.mp3')
  const s4 = await run({ verb: 'synth', input: 'hi', voice: 'zz', response_format: 'mp3', out: noFile })
  ok('tool(synth 400): backend error surfaced', s4.error.includes('HTTP 400') && s4.error.includes('not found'))
  ok('tool(synth 400): file not written', !fs.existsSync(noFile))

  // required-argument checks
  eq('tool(synth no input): error', (await run({ verb: 'synth', voice: 'v' })).error, 'synth: input is required (non-empty text)')
  eq('tool(synth no voice): error', (await run({ verb: 'synth', input: 'x' })).error, 'synth: voice is required (discover it with the voices verb)')

  // multiple providers, no default
  process.env[O] = BASE
  process.env[MODELS_O] = 'a,b'
  eq('tool(multi no default): asks for provider', (await run({ verb: 'synth', input: 'x', voice: 'v' })).error, 'multiple providers configured (kokoro-local, other) and no default is set; pass the provider argument explicitly')
  behaviors.speech = 'good-wav'
  const s5 = await run({ verb: 'synth', provider: 'other', input: 'x', voice: 'v', model: 'a', out: path.join(outDir, 'two.wav') })
  eq('tool(multi): explicit provider works', s5.provider, 'other')
  eq('tool(multi): unknown provider', (await run({ verb: 'synth', provider: 'nope', input: 'x', voice: 'v' })).error, 'unknown provider "nope" (configured: kokoro-local, other)')
  eq('tool(multi): model list asked', (await run({ verb: 'synth', provider: 'other', input: 'x', voice: 'v' })).error, 'provider "other" declares 2 models (a, b); pass the model argument explicitly')

  // default provider
  process.env[D] = 'other'
  const s6 = await run({ verb: 'synth', input: 'x', voice: 'v', model: 'a', out: path.join(outDir, 'three.wav') })
  eq('tool(default): default route used', s6.provider, 'other')

  // discovery-driven model default (no declared models on the route)
  delete process.env[O]
  delete process.env[MODELS_O]
  delete process.env[D]
  delete process.env[MODELS_K]
  process.env[KEYREF_K] = TTS_TEST_KEY_NAME
  behaviors.models = 'single'
  const s7 = await run({ verb: 'synth', provider: 'kokoro-local', input: 'x', voice: 'v', out: path.join(outDir, 'four.wav') })
  eq('tool(discovery): single discovered model auto', s7.model, 'kokoro-v1')
  behaviors.models = 'envelope'
  eq('tool(discovery): multi discovered model asks', (await run({ verb: 'synth', provider: 'kokoro-local', input: 'x', voice: 'v' })).error, 'provider "kokoro-local" exposes 2 models (kokoro-v1, v2); pass the model argument explicitly')

  // providers verb: provenance, credential state
  behaviors.models = 'single'
  const pv = await run({ verb: 'providers' })
  ok('tool(providers): configured', pv.configured === true)
  const entry = pv.providers[0]
  eq('tool(providers): name', entry.name, 'kokoro-local')
  eq('tool(providers): base url source env', entry.fields.base_url, 'env')
  eq('tool(providers): credential ok', entry.credential, 'ok')
  eq('tool(providers): default null', pv.default, null)

  // missing credential on a credentialed provider
  delete process.env[TTS_TEST_KEY_NAME]
  behaviors.models = 'single'
  const s8 = await run({ verb: 'synth', input: 'x', voice: 'v', out: path.join(outDir, 'five.wav') })
  ok('tool(credential missing): error surfaced', s8.error.includes('credential missing') && s8.error.includes(TTS_TEST_KEY_NAME))
  const pvc = await run({ verb: 'providers' })
  eq('tool(providers): credential missing state', pvc.providers[0].credential, 'missing')
  process.env[TTS_TEST_KEY_NAME] = 'testkey'

  // voices: live + query filter + static fallback
  behaviors.voices = 'list'
  const v1 = await run({ verb: 'voices', provider: 'kokoro-local' })
  eq('tool(voices): source live', v1.source, 'live')
  eq('tool(voices): count', v1.count, 3)
  const v2 = await run({ verb: 'voices', provider: 'kokoro-local', query: 'zf' })
  eq('tool(voices): query filter', v2.voices.map((v) => v.id), ['zf_xiaoxiao', 'zf_yunjian'])
  const v2f = await run({ verb: 'voices', provider: 'kokoro-local', filter: 'zf_' })
  eq('tool(voices): filter prefix', v2f.voices.map((v) => v.id), ['zf_xiaoxiao', 'zf_yunjian'])
  const v2f2 = await run({ verb: 'voices', provider: 'kokoro-local', filter: 'nope_' })
  eq('tool(voices): filter no match', v2f2.voices, [])
  const v2c = await run({ verb: 'voices', provider: 'kokoro-local', filter: 'zf', query: 'yunjian' })
  eq('tool(voices): filter + query combine', v2c.voices.map((v) => v.id), ['zf_yunjian'])
  behaviors.voices = '404'
  const v3 = await run({ verb: 'voices', provider: 'kokoro-local' })
  eq('tool(voices): static fallback', v3.source, 'static')
  eq('tool(voices): static count', v3.count, 6)
  behaviors.voices = 'list'

  // status (single route auto)
  behaviors.models = 'single'
  behaviors.health = 'ok'
  const st = await run({ verb: 'status' })
  eq('tool(status): provider', st.provider, 'kokoro-local')
  eq('tool(status): reachable', st.reachable, true)
  eq('tool(status): models', st.models, ['kokoro-v1'])
  eq('tool(status): health', st.health, { status: 'ok' })
  const stAll = await run({ verb: 'status', provider: 'kokoro-local' })
  eq('tool(status): explicit single shape', stAll.reachable, true)

  // phonemize: supported, unsupported, missing text
  behaviors.phonemize = 'ok'
  const ph = await run({ verb: 'phonemize', provider: 'kokoro-local', text: 'hi', language: 'zh' })
  eq('tool(phonemize): supported', ph.supported, true)
  eq('tool(phonemize): result', ph.result, { phonemes: ['h', 'i'] })
  behaviors.phonemize = '404'
  const ph2 = await run({ verb: 'phonemize', provider: 'kokoro-local', text: 'hi' })
  eq('tool(phonemize): unsupported', ph2, { provider: 'kokoro-local', supported: false, error: 'backend does not implement /dev/phonemize' })
  eq('tool(phonemize): missing text', (await run({ verb: 'phonemize', provider: 'kokoro-local' })).error, 'phonemize: text is required (non-empty)')

  // output placement: default root under the process cwd, directory via trailing separator
  process.chdir(outDir)
  behaviors.speech = 'good-wav'
  const s9 = await run({ verb: 'synth', input: 'x', voice: 'zf_xiaoxiao' })
  ok('tool(out default): file under cwd/tts', s9.out.startsWith(path.join(outDir, 'tts')) && s9.out.endsWith('.wav'))
  ok('tool(out default): file exists', fs.existsSync(s9.out))
  const dirOut = path.join(outDir, 'sub') + path.sep
  const s10 = await run({ verb: 'synth', input: 'x', voice: 'zf_xiaoxiao', out: dirOut })
  ok('tool(out dir): auto name in the directory', s10.out.startsWith(dirOut) && s10.out.endsWith('_zf_xiaoxiao.wav'))
  ok('tool(out dir): file exists', fs.existsSync(s10.out))

  // mp3 container: no rate/duration, no warnings
  behaviors.speech = 'mp3'
  const s11 = await run({ verb: 'synth', input: 'x', voice: 'zf_xiaoxiao', response_format: 'mp3', out: path.join(outDir, 'six.mp3') })
  eq('tool(mp3): sample rate null', s11.sample_rate, null)
  eq('tool(mp3): duration null', s11.duration_s, null)
  ok('tool(mp3): no warnings', s11.warnings === undefined)
  ok('tool(mp3): file on disk', fs.existsSync(s11.out))

  // resolveOutPath unit checks (pure)
  const p1 = resolveOutPath(undefined, 'v/with:chars', 'wav', '/tmp')
  ok('tool(resolveOut): auto name sanitized', p1.endsWith('.wav') && !/[/:]/.test(path.basename(p1)))
  const p2 = resolveOutPath('/tmp/xx/', 'v', 'pcm', '/tmp')
  ok('tool(resolveOut): dir + pcm extension', p2.startsWith('/tmp/xx/') && p2.endsWith('.pcm'))

  process.chdir(PKG)
  for (const k of touched) delete process.env[k]
  if (savedHome === null) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedKey === null) delete process.env[TTS_TEST_KEY_NAME]
  else process.env[TTS_TEST_KEY_NAME] = savedKey
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}

// -- plugin entry point (class wiring, the bundled skill, the delivered
//    config schema) -----------------------------------------------------------

{
  const provided = []
  const registered = []
  const skillCalls = []
  const sections = []
  const pctx = {
    reflect: { provide: (name) => { provided.push(name) } },
    logger: () => ({ warn: () => {} }),
    tools: {
      register: (def) => {
        registered.push(def)
        return () => {}
      },
    },
    skills: {
      registerProvider: (f) => {
        skillCalls.push(f)
        return () => {}
      },
    },
    systemPrompt: { section: (s) => sections.push(s) },
  }
  const plugin = new DshTtsPlugin(pctx, { defaultProvider: 'stub', providers: { stub: { baseURL: 'http://stub' } } })
  eq('plugin: service name', plugin.name, 'dsh-tts')
  eq('plugin: provided under the plugin id', provided, ['dsh-tts'])
  eq('plugin: tool registered once', registered.map((d) => d.name), ['tts'])
  eq('plugin: tool verbs', registered[0].parameters.properties.verb.enum, [...VERBS])
  eq('plugin: system prompt section', sections.map((s) => [s.name, s.order]), [['dsh-tts', 3000]])

  // the bundled skill registers under the plugin name
  eq('plugin: one skill provider', skillCalls.length, 1)
  const sp = await skillCalls[0]()
  eq('plugin: skill provider name', sp.name, 'dsh-tts')
  const cand = (await sp.list())[0]
  eq('plugin: skill candidate name', cand.name, 'dsh-tts')
  eq('plugin: skill candidate provider', cand.provider, 'dsh-tts')
  eq('plugin: skill candidate source', cand.source, 'bundled')
  ok('plugin: skill description', typeof cand.description === 'string' && cand.description.length > 0)
  ok('plugin: skill invocation open', cand.invocation.modelInvocable === true && cand.invocation.userInvocable === true)
  const got = await sp.get(cand)
  ok('plugin: skill body', typeof got.content === 'string' && got.content.length > 0 && !got.content.startsWith('---'))
  ok('plugin: skill body has the title', got.content.includes('# dsh-tts'))
  eq('plugin: skill get unknown candidate', await sp.get({ name: 'other' }), undefined)

  // the Config schema: a valid patch normalizes, unknown keys and bad names fail
  const cfg = DshTtsPlugin.Config({ defaultProvider: 'kokoro', providers: { kokoro: { baseURL: 'http://k', models: ['m1'] } } })
  eq('plugin(Config): valid patch normalizes', cfg.providers.kokoro.baseURL, 'http://k')
  let e1 = null
  try {
    DshTtsPlugin.Config({ providers: { kokoro: { baseURL: 'http://k', bogus: 1 } } })
  } catch (e) {
    e1 = e
  }
  ok('plugin(Config): unknown provider key rejected', e1 !== null && e1.name === 'ValidationError' && e1.message.includes('unknown key'))
  let e2 = null
  try {
    DshTtsPlugin.Config({ providers: { '9bad': { baseURL: 'http://k' } } })
  } catch (e) {
    e2 = e
  }
  ok('plugin(Config): invalid provider name rejected', e2 !== null && e2.name === 'ValidationError')
  let e3 = null
  try {
    DshTtsPlugin.Config({ bogusTop: 1 })
  } catch (e) {
    e3 = e
  }
  ok('plugin(Config): unknown top-level key rejected', e3 !== null && e3.name === 'ValidationError')
}

// -- manifest sanity ----------------------------------------------------------

{
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  eq('manifest: name', manifest.name, 'dsh-tts')
  eq('manifest: module type', manifest.type, 'module')
  eq('manifest: entry', manifest.main, './lib/index.js')
  ok('manifest: exports point at entry + types', manifest.exports['.'].default === './lib/index.js' && manifest.exports['.'].types === './lib/index.d.ts')
  ok('manifest: no runtime dependencies', !('dependencies' in manifest))
  ok('manifest: peer set', ['@deepseek-ai/cordis', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/schemastery', 'yaml'].every((p) => p in manifest.peerDependencies))
  eq('manifest: bundle patch pointer', manifest.dsh.bundle.patch, './cordis.patch.yml')
  ok('manifest: bundle patch file present', fs.existsSync(path.join(PKG, 'cordis.patch.yml')))
  ok('manifest: files entries present', manifest.files.every((f) => fs.existsSync(path.join(PKG, f.replace(/\/$/, '')))))
  const patch = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok('manifest: patch registers the plugin id', patch.includes('id: dsh-tts') && patch.includes("name: 'dsh-tts'"))
  ok('manifest: compiled entry present', fs.existsSync(path.join(PKG, 'lib', 'index.js')))
}

// -- shipped-file gates -------------------------------------------------------

{
  const root = PKG
  const walk = (dir) => {
    const out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(p))
      else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs') || e.name.endsWith('.md') || e.name.endsWith('.json') || e.name.endsWith('.yml') || e.name.endsWith('.yaml') || e.name.endsWith('.js')) out.push(p)
    }
    return out
  }
  const shipped = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'test')), ...walk(path.join(root, 'lib')), ...walk(path.join(root, 'skill')), path.join(root, 'package.json'), path.join(root, 'README.md'), path.join(root, 'cordis.patch.yml')]
  const NON_ASCII_RE = /[^\x00-\x7f]/
  const bad = []
  for (const f of shipped) {
    const text = fs.readFileSync(f, 'utf8')
    if (NON_ASCII_RE.test(text)) bad.push(path.relative(root, f))
  }
  eq('ascii gate: all shipped files strict ASCII', bad, [])
  ok('ascii gate: shipped file set non-empty', shipped.length > 0)
}

// -- selftest hygiene guard ---------------------------------------------------

{
  const raw = fs.readFileSync(path.join(PKG, 'test', 'selftest.mjs'), 'utf8')
  const testSrc = raw.slice(0, raw.indexOf('// selftest hygiene guard'))
  ok('selftest hygiene: no design-doc section pointers', !/design doc|design v\d|spec \u00a7|\u00a7\d/.test(testSrc))
  ok('selftest hygiene: no machine-specific paths', !/\/workspace\//.test(testSrc))
  ok('selftest hygiene: no source line-number pointers', !/L\d+[-\u2013\u2014]L?\d+/.test(testSrc))
  ok('selftest hygiene: no review-round wrappers', !/round-?\d+|review #\d/.test(testSrc))
  ok('selftest hygiene: no project version-round tags', !/\bv\d{2}\b/.test(testSrc))
  ok('selftest hygiene: no CJK characters', !CJK_RE.test(testSrc))
}

// -- results ------------------------------------------------------------------

server.closeAllConnections()
await new Promise((r) => server.close(r))
console.log(`selftest: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  FAIL: ${f}`)
process.exit(failures.length > 0 ? 1 : 0)
