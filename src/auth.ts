import type { PlaudSyncConfig } from './config.js'
import type { TokenData } from './types.js'

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export class PlaudAuth {
  private config: PlaudSyncConfig

  constructor(config: PlaudSyncConfig) {
    this.config = config
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken()
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken
    }
    throw new Error(
      'No valid token. Run `plaud-sync login` to authenticate via the browser.',
    )
  }

  private isExpiringSoon(token: TokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt
  }
}
