import { Database } from 'bun:sqlite'
import * as path from 'path'
import * as fs from 'fs'

export class SyncDb {
  private db: Database

  constructor(outputFolder: string) {
    fs.mkdirSync(outputFolder, { recursive: true })
    this.db = new Database(path.join(outputFolder, 'plaud-sync.db'))
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        base_name TEXT NOT NULL,
        audio_ext TEXT NOT NULL,
        downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
        transcribed_at TEXT
      )
    `)
  }

  findByRecordingId(id: string): { baseName: string; audioExt: string } | null {
    const row = this.db.query('SELECT base_name, audio_ext FROM recordings WHERE id = ?').get(id) as
      | { base_name: string; audio_ext: string }
      | null
    if (!row) return null
    return { baseName: row.base_name, audioExt: row.audio_ext }
  }

  markDownloaded(id: string, baseName: string, audioExt: string): void {
    this.db
      .query('INSERT OR REPLACE INTO recordings (id, base_name, audio_ext) VALUES (?, ?, ?)')
      .run(id, baseName, audioExt)
  }

  markTranscribed(id: string): void {
    this.db.query("UPDATE recordings SET transcribed_at = datetime('now') WHERE id = ?").run(id)
  }

  isTranscribed(id: string): boolean {
    const row = this.db.query('SELECT transcribed_at FROM recordings WHERE id = ?').get(id) as
      | { transcribed_at: string | null }
      | null
    return row?.transcribed_at != null
  }

  close(): void {
    this.db.close()
  }
}
