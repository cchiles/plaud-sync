import { z } from 'zod'

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
}

export const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  region: z.enum(['us', 'eu']),
})

export type Credentials = z.infer<typeof CredentialsSchema>

export const TokenDataSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  region: z.enum(['us', 'eu']),
})

export type TokenData = z.infer<typeof TokenDataSchema>

export const ConfigSchema = z.object({
  token: TokenDataSchema.optional(),
  hfToken: z.string().optional(),
  state: z.object({
    outputFolder: z.string().optional(),
    lastRunAt: z.number().optional(),
    lastSuccessAt: z.number().optional(),
    lastSummary: z.object({
      scanned: z.number(),
      downloaded: z.number(),
      transcribed: z.number(),
      skipped: z.number(),
      failed: z.number(),
      wallTimeMs: z.number(),
    }).optional(),
  }).optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export interface PlaudRecording {
  id: string
  filename: string
  fullname: string
  filesize: number
  duration: number
  start_time: number
  end_time: number
  is_trash: boolean
  is_trans: boolean
  is_summary: boolean
  keywords: string[]
  serial_number: string
}
