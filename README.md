# GLUMBO Discord Bot

Open-source Discord bot for the GLUMBO token on Ink. One process can run both features:

1. **Buy alerts** for confirmed Sentry buys of **$0.01 or more**.
2. **Signed-wallet holder verification** with automatic Discord roles.

Verification uses a free message signature only. It never asks for a transaction, gas, token approval, private key, or seed phrase. Balances are read from the GLUMBO contract on Ink.

## Features

- `/verify` — private, expiring wallet-verification link
- `/holder-status` — connected wallet, last balance, and roles
- `/unverify` — drop the wallet link and managed GLUMBO roles
- Rechecks verified wallets every six hours and updates roles
- Buy embeds with USD size, tokens received, price, estimated FDV, buyer, and Ink Explorer link
- Uses Sentry `isBuy` so transfers and rewards are not treated as buys

## Default holder roles

Created automatically the first time someone verifies:

| Balance | Roles assigned |
| ---: | --- |
| 1–99,999 GLUMBO | `GLUMBO Holder` |
| 100,000–999,999 | `GLUMBO Holder` + `GLUMBO 100K Club` |
| 1,000,000–9,999,999 | `GLUMBO Holder` + `GLUMBO 1M Club` |
| 10,000,000+ | `GLUMBO Holder` + `GLUMBO Whale` |

Only the base holder role and the member's highest tier are assigned. Override names and thresholds with `ROLE_TIERS_JSON`.

## Security

- A signature proves control of an address. It cannot move funds.
- Verification links expire after 15 minutes; signature challenges after 10 minutes.
- Challenges are one-time and bound to the Discord user, guild, wallet, domain, and Ink chain ID.
- EOA and EIP-1271 contract wallets are supported.
- Discord interaction signatures are checked before commands run.
- Never commit `.env`. Never paste a bot token, webhook URL, or session secret into GitHub, Discord, or public chat.
- If a token or webhook leaks, rotate it immediately in the Discord Developer Portal / hosting panel.

## Repository layout

The repo root should contain `bot.mjs`, `holder-verification.mjs`, `package.json`, `README.md`, `test.mjs`, and `.env.example`.

Requires Node.js 18+. There are no third-party packages.

Local checks:

- `npm run check`
- `npm run preview`

`npm run preview` prints a sample buy-alert payload. It does not post to Discord.

## Setup

### 1. Discord application

1. Open the Discord Developer Portal and create an application.
2. Copy Application ID and Public Key from General Information.
3. Open Bot, reset/create the token, and copy it once. Treat it as a password.
4. Invite the app to your server with scopes `bot` and `applications.commands`.
5. Grant Manage Roles.
6. In Server Settings → Roles, put the bot's role above every holder role it must assign.

### 2. Hosting

Any host that can run Node and expose HTTPS works (Railway, Fly, a VPS, etc.).

- Generate a public HTTPS URL with no trailing slash. That is `PUBLIC_URL`.
- Deploy after env vars are set.
- In Discord → General Information, set Interaction Endpoint URL to `https://YOUR-PUBLIC-DOMAIN/discord/interactions`.

Discord will verify the endpoint. Redeploy once so slash commands register.

### 3. Environment variables

Copy `.env.example` to `.env` locally. On a host, set the same names in the provider's secret/variable UI — not in git.

Required for holder verification:

- `DISCORD_APPLICATION_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_GUILD_ID`
- `PUBLIC_URL` (example: `https://your-domain.example`)
- `SESSION_SECRET`

`DISCORD_GUILD_ID` is the server ID (Discord Settings → Advanced → Developer Mode → right-click server → Copy Server ID).

`SESSION_SECRET` must be a new random string of at least 32 characters. Do not reuse a wallet, Discord, email, or host password.

Optional:

- `INK_RPC_URL=https://rpc-gel.inkonchain.com`
- `ROLE_REFRESH_MS=21600000`
- `STATE_FILE=./state.json`
- `VERIFY_DB_FILE=./verifications.json`
- `ROLE_TIERS_JSON`

Buy alerts (keep or omit if you only want verification):

- `DISCORD_WEBHOOK_URL`
- `TOKEN_ADDRESS=0x78BABF93Be6bCc08112d5De69E115C877837b360`
- `TOKEN_SYMBOL=GLUMBO`
- `MIN_BUY_USD=0.01`
- `TOTAL_SUPPLY=1000000000`
- `POLL_INTERVAL_MS=5000`
- `REPLAY_LATEST=false`

`TOKEN_ADDRESS` is the public GLUMBO contract on Ink. Point it at another token if you fork the bot.

### 4. Persistent storage

Mappings live in `verifications.json`. On ephemeral hosts (including Railway), attach a volume (for example `/data`) and set:

- `STATE_FILE=/data/buy-state.json`
- `VERIFY_DB_FILE=/data/verifications.json`

Without a volume, verification still works, but members may need to verify again after a new instance starts.

The verification DB links public wallet addresses to Discord user IDs. Restrict who can read the host filesystem and volume.

## Verify from a wallet

1. In Discord, run `/verify`.
2. Open Connect wallet & verify in the private reply.
3. On iOS Safari, use Open in MetaMask (or open the URL in another EVM wallet's browser).
4. Connect the wallet that holds the token.
5. Sign the message. The wallet must say Sign message, not send or approve.
6. The page shows balance and roles.

## Role notes

Role names must be unique. If matching names already exist, move them below the bot role or rename them before testing.
