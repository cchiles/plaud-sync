# Browser-Based Authentication

## Overview

Replace the current email/password login flow with a browser-based approach. The user logs in at `web.plaud.ai` (which supports email, Google, and Apple sign-in), then pastes a one-liner in the browser console to send the token to the CLI. This eliminates plaintext credential storage on disk.

## Login Flow

1. User runs `plaud-sync login`
2. CLI asks: `Region (us/eu) [us]:`
3. CLI starts a local HTTP server on a random available port (port `0`)
4. CLI opens `web.plaud.ai` in the default browser via `open` command
5. CLI prints instructions with a `fetch()` one-liner containing the actual port
6. User logs in to Plaud, opens DevTools console (Cmd+Option+J), pastes the one-liner
7. The one-liner reads `localStorage.getItem('tokenstr')` and `localStorage.getItem('plaud_user_api_domain')` and POSTs them to `http://localhost:PORT/capture`
8. CLI validates the JWT (structure, `exp` claim), extracts region from domain if available. Strips the `bearer ` prefix from the `tokenstr` value before processing.
9. Saves token data and region to config (no credentials stored)
10. Prints success message with expiration date, shuts down server

**Timeout:** 5 minutes, then exit with a message.

## Codebase Changes

### Removed

- `Credentials` type and `CredentialsSchema` from `src/types.ts`
- `credentials` field from `ConfigSchema`
- `saveCredentials()` and `getCredentials()` from `src/config.ts`
- `PlaudAuth.login()` method that sends email/password to the API
- Email/password prompts from `loginCommand()`

### Modified

**`src/types.ts`**
- Remove `CredentialsSchema` and `Credentials`
- Add `region` field to `TokenDataSchema`
- Remove `credentials` from `ConfigSchema`

**`src/config.ts`**
- Remove `saveCredentials()` and `getCredentials()`
- Keep `saveToken()` and `getToken()`

**`src/auth.ts`**
- `getToken()` checks for cached token; if missing or expired, throws with message to run `plaud-sync login`
- Remove `login()` method (no auto-re-auth — token lasts ~10 months)
- Constructor takes config only (no credentials needed)

**`src/cli.ts`**
- `loginCommand()` rewritten: region prompt, local HTTP server, browser open, wait for POST, validate, save
- `syncCommand()` reads region from stored token data instead of credentials
- Local HTTP server uses `Bun.serve`, browser opened via `Bun.spawn(['open', url])`

### New Code (all in `src/cli.ts`)

- Local HTTP server listening for `POST /capture` with JSON body `{ token, domain }`
- CORS headers: `Access-Control-Allow-Origin: https://web.plaud.ai` on OPTIONS and POST
- JWT validation (structure and expiry)
- Browser launch via platform `open` command

### No New Dependencies

Bun provides built-in HTTP server and process spawning.

## Error Handling

| Scenario | Behavior |
|---|---|
| User closes terminal before pasting | Server shuts down, no state change |
| Invalid/malformed token pasted | CLI rejects, prints error, keeps waiting |
| Token already expired | CLI warns and rejects, keeps waiting |
| CORS preflight | Server responds with correct `Access-Control-Allow-Origin` |
| Port conflict | Port `0` lets OS pick available port |
| `plaud_user_api_domain` is null | Fall back to user-selected region |
| Token expired during sync | Exit with message: "Token expired. Run 'plaud-sync login' to re-authenticate." |
| 5 minute timeout | Print message and exit |
