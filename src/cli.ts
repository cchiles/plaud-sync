import * as readline from 'readline'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { PlaudSyncConfig } from './config.js'
import { PlaudAuth } from './auth.js'
import { PlaudClient } from './client.js'
import { Transcriber, findWhisperModel, checkPrerequisites } from './transcriber.js'
import { syncRecordings } from './sync.js'
import type { Credentials } from './types.js'

const DEFAULT_OUTPUT = path.join(os.homedir(), 'PlaudSync')

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function loginCommand(): Promise<void> {
  const email = await prompt('Email: ')
  const password = await prompt('Password: ')
  const regionInput = await prompt('Region (us/eu) [us]: ')
  const region = (regionInput === 'eu' ? 'eu' : 'us') as Credentials['region']

  const config = new PlaudSyncConfig()
  config.saveCredentials({ email, password, region })

  const auth = new PlaudAuth(config)
  try {
    await auth.getToken()
    process.stdout.write('Login successful. Token saved.\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Login failed: ${message}\n`)
    process.exit(1)
  }
}

async function syncCommand(folder: string): Promise<void> {
  const config = new PlaudSyncConfig()
  const creds = config.getCredentials()

  if (!creds) {
    process.stderr.write('No credentials configured. Run `plaud-sync login` first.\n')
    process.exit(1)
  }

  const modelPath = findWhisperModel()
  const errors = checkPrerequisites(modelPath)
  if (errors.length > 0) {
    process.stderr.write('Prerequisites missing:\n')
    for (const err of errors) {
      process.stderr.write(`  - ${err}\n`)
    }
    process.exit(1)
  }

  const auth = new PlaudAuth(config)
  const client = new PlaudClient(auth, creds.region)
  const transcriber = new Transcriber(modelPath!)

  await syncRecordings(client, transcriber, folder)
}

const PLIST_LABEL = 'com.plaud-sync.agent'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const LOG_DIR = path.join(os.homedir(), '.plaud-sync', 'logs')

function generatePlist(intervalMinutes: number, outputFolder: string): string {
  const binPath = process.argv[1]
  const bunPath = process.execPath

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${binPath}</string>
    <string>sync</string>
    <string>${outputFolder}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'stderr.log')}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`
}

function installCommand(args: string[]): void {
  let folder = DEFAULT_OUTPUT
  let intervalMinutes = 30

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      intervalMinutes = parseInt(args[i + 1], 10)
      i++
    } else {
      folder = args[i]
    }
  }

  if (isNaN(intervalMinutes) || intervalMinutes < 1) {
    process.stderr.write('Interval must be a positive number of minutes.\n')
    process.exit(1)
  }

  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true })

  const plist = generatePlist(intervalMinutes, folder)
  fs.writeFileSync(PLIST_PATH, plist)

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  } catch {
    // Ignore if not loaded
  }
  execFileSync('launchctl', ['load', PLIST_PATH])

  process.stdout.write(`Installed. Syncing every ${intervalMinutes} minutes to ${folder}\n`)
  process.stdout.write(`Logs: ${LOG_DIR}\n`)
}

function uninstallCommand(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    process.stdout.write('LaunchAgent not installed.\n')
    return
  }

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH])
  } catch {
    // Ignore if not loaded
  }

  fs.unlinkSync(PLIST_PATH)
  process.stdout.write('LaunchAgent uninstalled.\n')
}

const USAGE = `plaud-sync v0.1.0

Usage: plaud-sync <command> [options]

Commands:
  login                          Configure Plaud credentials
  sync [folder]                  Sync recordings (default: ~/PlaudSync)
  install [folder] [--interval]  Install launchd agent (default: 30 min)
  uninstall                      Remove launchd agent`

export async function run(args: string[]): Promise<void> {
  const command = args[0]

  switch (command) {
    case 'login':
      return loginCommand()
    case 'sync':
      return syncCommand(args[1] || DEFAULT_OUTPUT)
    case 'install':
      return installCommand(args.slice(1))
    case 'uninstall':
      return uninstallCommand()
    default:
      process.stdout.write(USAGE + '\n')
  }
}
