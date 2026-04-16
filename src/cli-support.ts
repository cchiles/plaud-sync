import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { parseArgs } from 'util'
import { PlaudSyncConfig } from './config.js'
import type { SyncRunSummary as ConfigRunSummary } from './config.js'
import type { RecordingOrder } from './sync.js'
import { checkPrerequisites } from './transcriber.js'

export const VERSION = '0.3.6'
export const DEFAULT_OUTPUT = path.join(os.homedir(), 'PlaudSync')
const PLIST_LABEL = 'com.plaud-sync.agent'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const INSTALL_DIR = '/usr/local/bin'
const BINARY_PATH = path.join(INSTALL_DIR, 'plaud-sync')
export const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'plaud-sync')
const MODEL_CACHE_DIR = path.join(
  os.homedir(),
  '.cache',
  'huggingface',
  'hub',
  'models--mlx-community--whisper-small-mlx',
)

export interface ParsedInstallCommand {
  folder: string
  intervalMinutes: number
  maxRuntimeMinutes?: number
  recordingOrder: RecordingOrder
  runAtLoad: boolean
  noDiarize: boolean
  help: boolean
}

interface LaunchAgentInfo {
  installed: boolean
  intervalMinutes?: number
  programArguments?: string[]
  runAtLoad?: boolean
}

interface StatusPayload {
  configPath: string
  outputFolder: string
  tokenExpiry: number | null
  hfTokenConfigured: boolean
  launchAgent: {
    installed: boolean
    intervalMinutes: number | null
    runAtLoad: boolean | null
    syncFlags: string
  }
  lastRunAt: number | null
  lastSuccessAt: number | null
  lastSummary: ConfigRunSummary | null
}

interface DoctorPayload {
  configPath: string
  tokenPresent: boolean
  hfTokenPresent: boolean
  prerequisites: string[]
  modelCachePresent: boolean
  outputFolder: string
  outputWritable: boolean
  logsPath: string
  dbPath: string
  launchAgentInstalled: boolean
}

function formatDateTime(timestamp?: number | null): string {
  if (!timestamp) return 'n/a'
  return new Date(timestamp).toLocaleString()
}

function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw == null) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

function parseRecordingOrder(raw: string | undefined): RecordingOrder {
  if (!raw) return 'newest'
  if (raw === 'newest' || raw === 'oldest') return raw
  throw new Error('`--recording-order` must be `newest` or `oldest`.')
}

export function requireRecordingOrder(raw: string | undefined): RecordingOrder {
  return parseRecordingOrder(raw)
}

function parseBooleanOption(raw: string | undefined, label: string, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${label} must be true or false.`)
}

export function parseInstallCommand(args: string[]): ParsedInstallCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      interval: { type: 'string' },
      'max-runtime-minutes': { type: 'string' },
      'recording-order': { type: 'string' },
      'run-at-load': { type: 'string' },
      'no-diarize': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const intervalMinutes = parsePositiveInteger(parsed.values.interval ?? '30', '--interval') ?? 30
  return {
    folder: parsed.positionals[0] ?? DEFAULT_OUTPUT,
    intervalMinutes,
    maxRuntimeMinutes: parsePositiveInteger(parsed.values['max-runtime-minutes'], '--max-runtime-minutes'),
    recordingOrder: parseRecordingOrder(parsed.values['recording-order'] ?? 'oldest'),
    runAtLoad: parseBooleanOption(parsed.values['run-at-load'], '--run-at-load', true),
    noDiarize: Boolean(parsed.values['no-diarize']),
    help: Boolean(parsed.values.help),
  }
}

export function generatePlist(options: {
  intervalMinutes: number
  syncArgs: string[]
  runAtLoad: boolean
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BINARY_PATH}</string>
${options.syncArgs.map((arg) => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>${options.intervalMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'stderr.log')}</string>
  <key>RunAtLoad</key>
  <${options.runAtLoad ? 'true' : 'false'}/>
</dict>
</plist>`
}

function readLaunchAgentInfo(): LaunchAgentInfo {
  if (!fs.existsSync(PLIST_PATH)) {
    return { installed: false }
  }

  const content = fs.readFileSync(PLIST_PATH, 'utf-8')
  const programArgumentsMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  const programArguments =
    programArgumentsMatch?.[1]
      .match(/<string>([\s\S]*?)<\/string>/g)
      ?.map((value) => value.replace(/^<string>|<\/string>$/g, '')) ?? []
  const intervalMatch = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/)
  const runAtLoad = /<key>RunAtLoad<\/key>\s*<(true|false)\/>/.exec(content)?.[1] === 'true'

  return {
    installed: true,
    intervalMinutes: intervalMatch ? Number.parseInt(intervalMatch[1], 10) / 60 : undefined,
    programArguments,
    runAtLoad,
  }
}

function detectModelCache(): boolean {
  return fs.existsSync(MODEL_CACHE_DIR)
}

function toPrintableSyncFlags(programArguments?: string[]): string {
  if (!programArguments || programArguments.length <= 2) return 'none'
  return programArguments.slice(2).join(' ')
}

function buildStatusPayload(): StatusPayload {
  const config = new PlaudSyncConfig()
  const state = config.getState()
  const token = config.getToken()
  const launchAgent = readLaunchAgentInfo()

  return {
    configPath: config.filePath(),
    outputFolder: state?.outputFolder ?? DEFAULT_OUTPUT,
    tokenExpiry: token?.expiresAt ?? null,
    hfTokenConfigured: Boolean(config.getHfToken()),
    launchAgent: {
      installed: launchAgent.installed,
      intervalMinutes: launchAgent.intervalMinutes ?? null,
      runAtLoad: launchAgent.runAtLoad ?? null,
      syncFlags: toPrintableSyncFlags(launchAgent.programArguments),
    },
    lastRunAt: state?.lastRunAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastSummary: state?.lastSummary ?? null,
  }
}

function buildDoctorPayload(): DoctorPayload {
  const config = new PlaudSyncConfig()
  const outputFolder = config.getOutputFolder() ?? DEFAULT_OUTPUT
  let outputWritable = false

  try {
    fs.mkdirSync(outputFolder, { recursive: true })
    fs.accessSync(outputFolder, fs.constants.W_OK)
    outputWritable = true
  } catch {
    outputWritable = false
  }

  return {
    configPath: config.filePath(),
    tokenPresent: Boolean(config.getToken()),
    hfTokenPresent: Boolean(config.getHfToken()),
    prerequisites: checkPrerequisites(),
    modelCachePresent: detectModelCache(),
    outputFolder,
    outputWritable,
    logsPath: LOG_DIR,
    dbPath: path.join(outputFolder, 'plaud-sync.db'),
    launchAgentInstalled: readLaunchAgentInfo().installed,
  }
}

export function renderStatus(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
    },
  })
  const payload = buildStatusPayload()
  if (parsed.values.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }

  process.stdout.write('Status\n')
  process.stdout.write(`  Config: ${payload.configPath}\n`)
  process.stdout.write(`  Output: ${payload.outputFolder}\n`)
  process.stdout.write(`  Token expiry: ${formatDateTime(payload.tokenExpiry)}\n`)
  process.stdout.write(`  HF token: ${payload.hfTokenConfigured ? 'configured' : 'missing'}\n`)
  process.stdout.write(`  LaunchAgent: ${payload.launchAgent.installed ? 'installed' : 'not installed'}\n`)
  if (payload.launchAgent.installed) {
    process.stdout.write(`  Interval: ${payload.launchAgent.intervalMinutes ?? 'n/a'} minutes\n`)
    process.stdout.write(`  RunAtLoad: ${payload.launchAgent.runAtLoad}\n`)
    process.stdout.write(`  Sync flags: ${payload.launchAgent.syncFlags}\n`)
  }
  process.stdout.write(`  Last run: ${formatDateTime(payload.lastRunAt)}\n`)
  process.stdout.write(`  Last success: ${formatDateTime(payload.lastSuccessAt)}\n`)
  if (payload.lastSummary) {
    process.stdout.write(
      `  Last summary: scanned=${payload.lastSummary.scanned}, downloaded=${payload.lastSummary.downloaded}, transcribed=${payload.lastSummary.transcribed}, skipped=${payload.lastSummary.skipped}, failed=${payload.lastSummary.failed}, wall=${Math.floor(payload.lastSummary.wallTimeMs / 1000)}s\n`,
    )
  }
}

export function renderDoctor(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
    },
  })
  const payload = buildDoctorPayload()
  if (parsed.values.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }

  process.stdout.write('Doctor\n')
  process.stdout.write(`  Config: ${payload.configPath}\n`)
  process.stdout.write(`  Plaud token: ${payload.tokenPresent ? 'present' : 'missing'}\n`)
  process.stdout.write(`  HF token: ${payload.hfTokenPresent ? 'present' : 'missing'}\n`)
  process.stdout.write(`  Model cache: ${payload.modelCachePresent ? 'present' : 'missing'}\n`)
  process.stdout.write(`  Output folder: ${payload.outputFolder}\n`)
  process.stdout.write(`  Output writable: ${payload.outputWritable ? 'yes' : 'no'}\n`)
  process.stdout.write(`  LaunchAgent: ${payload.launchAgentInstalled ? 'installed' : 'not installed'}\n`)
  if (payload.prerequisites.length === 0) {
    process.stdout.write('  Prerequisites: OK\n')
    return
  }

  process.stdout.write('  Prerequisites:\n')
  for (const issue of payload.prerequisites) {
    process.stdout.write(`    - ${issue}\n`)
  }
}

export function configHelp(): string {
  return `Usage:
  plaud-sync config path
  plaud-sync config show
  plaud-sync config set hf-token <token>`
}

export function syncHelp(): string {
  return `Usage: plaud-sync sync [folder] [options]

Sync options:
  --audio-only, --skip-transcription
  --transcribe-only, --skip-download
  --diarize
  --no-diarize
  --retranscribe
  --keep-audio
  --limit <n>
  --since <yyyy-mm-dd>
  --max-runtime-minutes <n>
  --recording-order <newest|oldest>
  --dry-run
  -v, --verbose

Examples:
  plaud-sync sync --limit 3
  plaud-sync sync --since 2026-04-01
  plaud-sync sync --dry-run
  plaud-sync sync ~/PlaudSync --recording-order oldest --max-runtime-minutes 20`
}

export function installHelp(): string {
  return `Usage: plaud-sync install [folder] [options]

Install options:
  --interval <minutes>
  --max-runtime-minutes <n>
  --recording-order <newest|oldest>
  --run-at-load <true|false>
  --no-diarize

Example:
  plaud-sync install ~/PlaudSync --interval 120 --max-runtime-minutes 20 --recording-order oldest`
}

export function usage(): string {
  return `plaud-sync v${VERSION}

Usage: plaud-sync <command> [options]

Commands:
  login                         Authenticate via Plaud web app
  sync [folder]                 Sync recordings
  install [folder]              Install or update launchd agent
  uninstall                     Remove launchd agent
  status [--json]               Show current config and launch agent status
  doctor [--json]               Run health checks
  config <subcommand>           Manage config values
  help                          Show this message

Examples:
  plaud-sync sync --limit 3
  plaud-sync sync --since 2026-04-01
  plaud-sync install ~/PlaudSync --interval 120 --max-runtime-minutes 20`
}

export function uninstallLaunchAgent(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    process.stdout.write('LaunchAgent not installed.\n')
    return
  }

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH])
  } catch {
    // Ignore if not loaded.
  }

  fs.unlinkSync(PLIST_PATH)
  process.stdout.write('LaunchAgent uninstalled.\n')
}

export function installLaunchAgent(options: {
  intervalMinutes: number
  syncArgs: string[]
  runAtLoad: boolean
}): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true })
  fs.writeFileSync(PLIST_PATH, generatePlist(options))

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  } catch {
    // Ignore if not loaded.
  }
  execFileSync('launchctl', ['load', PLIST_PATH])
}
