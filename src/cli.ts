import * as readline from 'readline'
import { parseArgs } from 'util'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import { PlaudClient } from './client.js'
import { Transcriber, checkPrerequisites } from './transcriber.js'
import { syncRecordings } from './sync.js'
import type { SyncOptions } from './sync.js'
import {
  DEFAULT_OUTPUT,
  LOG_DIR,
  configHelp,
  installHelp,
  installLaunchAgent,
  parseInstallCommand,
  requireRecordingOrder,
  renderDoctor,
  renderStatus,
  syncHelp,
  uninstallLaunchAgent,
  usage,
} from './cli-support.js'
import type { TokenData } from './types.js'

const DEFAULT_HEARTBEAT_MS = 60_000

interface ParsedSyncCommand {
  folder: string
  options: SyncOptions
  help: boolean
  deprecatedConcurrency?: number
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw == null) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

function parseDateArg(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('`--since` must be in YYYY-MM-DD format.')
  }
  const timestamp = Date.parse(`${raw}T00:00:00Z`)
  if (Number.isNaN(timestamp)) {
    throw new Error('`--since` must be a valid date.')
  }
  return timestamp
}

export function decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 }
}

export function parseTokenFromCapture(
  body: { token: string | null; domain: string | null },
  fallbackRegion: 'us' | 'eu' = 'us',
): TokenData {
  const raw = body.token ?? ''
  const jwt = raw.replace(/^bearer\s+/i, '')

  const decoded = decodeJwtExpiry(jwt)

  if (decoded.exp * 1000 < Date.now()) {
    throw new Error('Token is already expired. Please log in again and retry.')
  }

  let region: 'us' | 'eu' = fallbackRegion
  if (body.domain && body.domain.includes('euc1')) {
    region = 'eu'
  }

  return {
    accessToken: jwt,
    tokenType: 'Bearer',
    issuedAt: decoded.iat * 1000,
    expiresAt: decoded.exp * 1000,
    region,
  }
}

function parseSyncCommand(args: string[]): ParsedSyncCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'audio-only': { type: 'boolean' },
      'skip-transcription': { type: 'boolean' },
      'transcribe-only': { type: 'boolean' },
      'skip-download': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      'no-diarize': { type: 'boolean' },
      diarize: { type: 'boolean' },
      retranscribe: { type: 'boolean' },
      'keep-audio': { type: 'boolean' },
      limit: { type: 'string' },
      since: { type: 'string' },
      'max-runtime-minutes': { type: 'string' },
      'recording-order': { type: 'string' },
      'dry-run': { type: 'boolean' },
      concurrency: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const folder = parsed.positionals[0] ?? DEFAULT_OUTPUT
  const audioOnly = Boolean(parsed.values['audio-only'] || parsed.values['skip-transcription'])
  const transcribeOnly = Boolean(parsed.values['transcribe-only'] || parsed.values['skip-download'])
  const explicitDiarize = parsed.values.diarize === true
  const explicitNoDiarize = parsed.values['no-diarize'] === true

  if (audioOnly && transcribeOnly) {
    throw new Error('Choose only one of `--audio-only` and `--transcribe-only`.')
  }
  if (explicitDiarize && explicitNoDiarize) {
    throw new Error('Choose only one of `--diarize` and `--no-diarize`.')
  }

  return {
    folder,
    help: Boolean(parsed.values.help),
    deprecatedConcurrency: parsePositiveInteger(parsed.values.concurrency, '--concurrency'),
    options: {
      audioOnly,
      transcribeOnly,
      verbose: Boolean(parsed.values.verbose),
      noDiarize: explicitNoDiarize ? true : explicitDiarize ? false : false,
      retranscribe: Boolean(parsed.values.retranscribe),
      deleteAudioAfterTranscribe: !parsed.values['keep-audio'],
      limit: parsePositiveInteger(parsed.values.limit, '--limit'),
      since: parseDateArg(parsed.values.since),
      maxRuntimeMinutes: parsePositiveInteger(parsed.values['max-runtime-minutes'], '--max-runtime-minutes'),
      recordingOrder: requireRecordingOrder(parsed.values['recording-order']),
      dryRun: Boolean(parsed.values['dry-run']),
      interactive: Boolean(process.stdout.isTTY),
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
    },
  }
}

async function loginCommand(): Promise<void> {
  const regionInput = await prompt('Region (us/eu) [us]: ')
  const region = (regionInput === 'eu' ? 'eu' : 'us') as 'us' | 'eu'

  Bun.spawn(['open', 'https://web.plaud.ai'])

  process.stdout.write('\nBrowser opened. Log in to your Plaud account, then:\n')
  process.stdout.write('  1. On the web.plaud.ai tab, open DevTools (Cmd+Option+J)\n')
  process.stdout.write('  2. Paste this command and press Enter:\n\n')
  process.stdout.write(
    `     JSON.stringify({token:localStorage.getItem('tokenstr'),domain:localStorage.getItem('plaud_user_api_domain')})\n\n`,
  )
  process.stdout.write('  3. Copy the JSON output\n\n')

  const jsonInput = await prompt('Paste the JSON here: ')

  try {
    const cleaned = jsonInput.replace(/^['"`]+|['"`]+$/g, '')
    const body = JSON.parse(cleaned)
    const tokenData = parseTokenFromCapture(body, region)
    const config = new PlaudSyncConfig()
    config.saveToken(tokenData)
    const expiresDate = new Date(tokenData.expiresAt).toLocaleDateString()
    process.stdout.write(`Login successful. Token saved (expires ${expiresDate}).\n`)

    if (!config.getHfToken()) {
      process.stdout.write('\nSpeaker diarization requires a Hugging Face token (free, read access).\n')
      process.stdout.write('Setup: accept agreements at both URLs, then create a token:\n')
      process.stdout.write('  https://huggingface.co/pyannote/speaker-diarization-3.1\n')
      process.stdout.write('  https://huggingface.co/pyannote/segmentation-3.0\n')
      process.stdout.write('  https://huggingface.co/settings/tokens\n\n')
      const hfInput = await prompt('HF token (or Enter to skip): ')
      if (hfInput) {
        config.saveHfToken(hfInput)
        process.stdout.write('HF token saved.\n')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Login failed: ${message}\n`)
    process.exit(1)
  }
}

async function syncCommand(args: string[]): Promise<void> {
  const parsed = parseSyncCommand(args)
  if (parsed.help) {
    process.stdout.write(syncHelp() + '\n')
    return
  }

  if (parsed.deprecatedConcurrency != null) {
    process.stderr.write('Warning: `--concurrency` is deprecated and currently ignored because sync remains sequential.\n')
  }

  const config = new PlaudSyncConfig()
  const token = config.getToken()

  if (!token) {
    process.stderr.write('No token found. Run `plaud-sync login` first.\n')
    process.exit(1)
  }

  const hfToken = config.getHfToken()
  const diarizationRequested = !parsed.options.noDiarize
  if (!hfToken && diarizationRequested) {
    process.stderr.write('No HF token found. Run `plaud-sync login`, set HF_TOKEN, or pass `--no-diarize`.\n')
    process.exit(1)
  }

  const errors = checkPrerequisites()
  if (errors.length > 0) {
    process.stderr.write('Prerequisites missing:\n')
    for (const err of errors) {
      process.stderr.write(`  - ${err}\n`)
    }
    process.exit(1)
  }

  const auth = new PlaudAuth(config)
  const client = new PlaudClient(auth, token.region)
  const transcriber = new Transcriber()

  const summary = await syncRecordings(client, transcriber, parsed.folder, {
    ...parsed.options,
    hfToken,
  })

  const now = Date.now()
  config.saveRunState({
    outputFolder: parsed.folder,
    lastRunAt: now,
    lastSuccessAt: summary.failed === 0 && !summary.stoppedEarly ? now : undefined,
    lastSummary: {
      scanned: summary.scanned,
      downloaded: summary.downloaded,
      transcribed: summary.transcribed,
      skipped: summary.skipped,
      failed: summary.failed,
      wallTimeMs: summary.wallTimeMs,
    },
  })
}

function installCommand(args: string[]): void {
  const parsed = parseInstallCommand(args)
  if (parsed.help) {
    process.stdout.write(installHelp() + '\n')
    return
  }

  if (parsed.intervalMinutes < 1) {
    throw new Error('Interval must be a positive number of minutes.')
  }
  if (parsed.intervalMinutes < 60) {
    process.stderr.write('Warning: intervals under 60 minutes may keep the machine busy continuously for same-quality transcription workloads.\n')
  }

  const syncArgs = ['sync', parsed.folder, '--recording-order', parsed.recordingOrder]
  if (parsed.maxRuntimeMinutes) {
    syncArgs.push('--max-runtime-minutes', String(parsed.maxRuntimeMinutes))
  }
  if (parsed.noDiarize) {
    syncArgs.push('--no-diarize')
  }

  installLaunchAgent({
    intervalMinutes: parsed.intervalMinutes,
    syncArgs,
    runAtLoad: parsed.runAtLoad,
  })

  const config = new PlaudSyncConfig()
  config.setOutputFolder(parsed.folder)

  process.stdout.write(`Installed. Syncing every ${parsed.intervalMinutes} minutes to ${parsed.folder}\n`)
  process.stdout.write(`Flags: ${syncArgs.slice(2).join(' ') || 'none'}\n`)
  process.stdout.write(`Logs: ${LOG_DIR}\n`)
}

function uninstallCommand(): void {
  uninstallLaunchAgent()
}

function statusCommand(args: string[]): void {
  renderStatus(args)
}

function doctorCommand(args: string[]): void {
  renderDoctor(args)
}

function configCommand(args: string[]): void {
  const subcommand = args[0]
  const config = new PlaudSyncConfig()

  switch (subcommand) {
    case 'path':
      process.stdout.write(config.filePath() + '\n')
      return
    case 'show': {
      const payload = {
        configPath: config.filePath(),
        tokenConfigured: Boolean(config.getToken()),
        tokenExpiry: config.getToken()?.expiresAt ?? null,
        hfTokenConfigured: Boolean(config.getHfToken()),
        outputFolder: config.getOutputFolder() ?? DEFAULT_OUTPUT,
        state: config.getState() ?? null,
      }
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
      return
    }
    case 'set':
      if (args[1] === 'hf-token') {
        const value = args[2]
        if (!value) {
          throw new Error('Usage: plaud-sync config set hf-token <token>')
        }
        config.saveHfToken(value)
        process.stdout.write('HF token saved.\n')
        return
      }
      throw new Error(configHelp())
    default:
      process.stdout.write(configHelp() + '\n')
  }
}

export async function run(args: string[]): Promise<void> {
  const command = args[0]

  try {
    switch (command) {
      case 'login':
        return loginCommand()
      case 'sync':
        return syncCommand(args.slice(1))
      case 'install':
        return installCommand(args.slice(1))
      case 'uninstall':
        return uninstallCommand()
      case 'status':
        return statusCommand(args.slice(1))
      case 'doctor':
        return doctorCommand(args.slice(1))
      case 'config':
        return configCommand(args.slice(1))
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        process.stdout.write(usage() + '\n')
        return
      default:
        throw new Error(`Unknown command: ${command}\n\n${usage()}`)
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

export {
  parseInstallCommand,
  parseSyncCommand,
}
