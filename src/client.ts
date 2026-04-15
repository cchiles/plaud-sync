import type { PlaudAuth } from './auth.js'
import { BASE_URLS } from './types.js'
import type { PlaudRecording } from './types.js'

export class PlaudClient {
  private auth: PlaudAuth
  private region: string

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth
    this.region = region
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us']
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken()
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()

    if (data?.status === -302 && data?.data?.domains?.api) {
      const domain: string = data.data.domains.api
      this.region = domain.includes('euc1') ? 'eu' : 'us'
      return this.request(path, options)
    }

    return data
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web')
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? []
    return list.filter((r) => !r.is_trash)
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`)
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null
    } catch {
      return null
    }
  }

  async downloadAudio(id: string): Promise<Response> {
    const token = await this.auth.getToken()
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    return res
  }
}
