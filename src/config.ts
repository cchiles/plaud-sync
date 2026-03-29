import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConfigSchema } from './types.js'
import type { TokenData, Config } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'plaud-sync')
const CONFIG_FILE = 'config.json'

export class PlaudSyncConfig {
  private dir: string

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE)
  }

  private load(): Config {
    try {
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
}
