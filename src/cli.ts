import { Command } from 'commander'
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

function installCommand(folder: string, options: { interval: string }): void {
  const intervalMinutes = parseInt(options.interval, 10)
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

export function createProgram(): Command {
  const program = new Command()
  program.name('plaud-sync').description('Sync Plaud recordings and transcribe locally').version('0.1.0')

  program
    .command('login')
    .description('Configure Plaud credentials')
    .action(loginCommand)

  program
    .command('sync')
    .description('Sync recordings and transcribe locally')
    .argument('[folder]', 'Output folder', DEFAULT_OUTPUT)
    .action(syncCommand)

  program
    .command('install')
    .description('Install launchd agent for automatic syncing')
    .argument('[folder]', 'Output folder', DEFAULT_OUTPUT)
    .option('--interval <minutes>', 'Sync interval in minutes', '30')
    .action(installCommand)

  program
    .command('uninstall')
    .description('Remove launchd agent')
    .action(uninstallCommand)

  return program
}
