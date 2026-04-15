import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConfigSchema } from './types.js'
import type { TokenData, Config } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'plaud-sync')
const LEGACY_DIR = path.join(os.homedir(), '.config', 'plaud-sync')
const CONFIG_FILE = 'config.json'

export interface SyncRunSummary {
  scanned: number
  downloaded: number
  transcribed: number
  skipped: number
  failed: number
  wallTimeMs: number
}

export class PlaudSyncConfig {
  private dir: string
  private legacyDir: string

  constructor(dir?: string, legacyDir?: string) {
    this.dir = dir ?? DEFAULT_DIR
    this.legacyDir = legacyDir ?? LEGACY_DIR
  }

  filePath(): string {
    return path.join(this.dir, CONFIG_FILE)
  }

  legacyFilePath(): string {
    return path.join(this.legacyDir, CONFIG_FILE)
  }

  private ensureMigrated(): void {
    if (this.dir !== DEFAULT_DIR && this.legacyDir === LEGACY_DIR) return
    if (fs.existsSync(this.filePath())) return
    if (!fs.existsSync(this.legacyFilePath())) return

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(this.legacyFilePath(), this.filePath())
    fs.chmodSync(this.filePath(), 0o600)
  }

  private load(): Config {
    try {
      this.ensureMigrated()
      const raw = fs.readFileSync(this.filePath(), 'utf-8')
      return ConfigSchema.parse(JSON.parse(raw))
    } catch {
      return {}
    }
  }

  private save(partial: Partial<Config>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const existing = this.load()
    const merged = { ...existing, ...partial }
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 })
  }

  saveToken(token: TokenData): void {
    this.save({ token })
  }

  getToken(): TokenData | undefined {
    return this.load().token
  }

  saveHfToken(hfToken: string): void {
    this.save({ hfToken })
  }

  getHfToken(): string | undefined {
    return this.load().hfToken ?? process.env.HF_TOKEN
  }

  setOutputFolder(outputFolder: string): void {
    const existingState = this.load().state ?? {}
    this.save({ state: { ...existingState, outputFolder } })
  }

  getOutputFolder(): string | undefined {
    return this.load().state?.outputFolder
  }

  saveRunState(run: {
    outputFolder: string
    lastRunAt: number
    lastSuccessAt?: number
    lastSummary?: SyncRunSummary
  }): void {
    const existingState = this.load().state ?? {}
    this.save({
      state: {
        ...existingState,
        outputFolder: run.outputFolder,
        lastRunAt: run.lastRunAt,
        lastSuccessAt: run.lastSuccessAt ?? existingState.lastSuccessAt,
        lastSummary: run.lastSummary ?? existingState.lastSummary,
      },
    })
  }

  getState(): Config['state'] {
    return this.load().state
  }
}
