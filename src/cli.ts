import { Command } from 'commander'
import * as readline from 'readline'
import * as os from 'os'
import * as path from 'path'
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

  return program
}
