# Dev Assistant

A local TypeScript CLI assistant that combines GitHub notifications and Gmail messages, prioritizes urgent items, and generates a friendly daily action summary using a Groq-hosted model through the OpenAI SDK.

## What It Does

- Fetches GitHub notifications via Nango
- Fetches recent Gmail messages via Nango
- Scores urgency for GitHub and Gmail items
- Tracks new items since the last run using local digest state
- Prints a compact digest snapshot and an AI-written plan in the terminal

## Tech Stack

- Node.js + TypeScript
- `@nangohq/node` for connected account API calls
- `openai` SDK pointed to Groq endpoint
- `dotenv` for local environment variables

## Prerequisites

- Node.js 18+
- Nango connection IDs for GitHub and Gmail
- Groq API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local env file from the example:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Fill in required values in `.env`:

- `NANGO_SECRET_KEY`
- `GROQ_API_KEY`
- `NANGO_GITHUB_CONNECTION_ID`
- `NANGO_GMAIL_CONNECTION_ID`

Optional:

- `NANGO_GMAIL_PROVIDER_CONFIG_KEY` (default: `google-mail`)
- `NANGO_GITHUB_PROVIDER_CONFIG_KEY` (default: `github`)
- `DEBUG` (`true` to print raw payloads)
- `GITHUB_NOTIFICATIONS_LOOKBACK_DAYS` (default: `30`)

## Run

```bash
npx ts-node src/index.ts
```

## Output Sections

- `DIGEST SNAPSHOT`: quick totals and top items
- `GITHUB NOTIFICATIONS`: raw normalized GitHub data (shown when `DEBUG=true`)
- `GMAIL MESSAGES`: raw normalized Gmail data (shown when `DEBUG=true`)
- `ASSISTANT`: friendly prioritized summary and action plan

## Local State

The app stores last-run state in `.digest-state.json` to calculate what is new since the previous run.

## Git Safety

Sensitive and local-only files are ignored by git:

- `.env`
- `.env.*` (except `.env.example`)
- `.digest-state.json`
- `node_modules/`
- `dist/`

## Notes

- This project is currently optimized for local single-user use.
- Do not commit real secrets; use `.env.example` as the template for GitHub.
