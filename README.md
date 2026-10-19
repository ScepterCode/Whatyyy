# Between the Lines

A private-first WhatsApp chat report MVP. It reads WhatsApp `.txt` exports and `.zip` archives (extracting the chat text locally in the browser), lets the user identify themselves and choose a report voice, then asks a configured OpenAI-compatible model for an evidence-led conversation read.

## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and set the model values below.
4. Run `npm run dev` and open `http://localhost:3000`.

## Model settings

The server calls a chat-completions-compatible endpoint. Keep these values in `.env.local`; do not add API keys to client code or commit them.

```dotenv
MODEL_API_URL=https://your-provider.example/v1/chat/completions
MODEL_API_KEY=your-secret-key
MODEL_NAME=your-model-id
```

The app does not need the model key until the user requests an analysis. The report pipeline normalizes messages and deterministic metrics, then runs evidence analysis, narrative synthesis, report writing, and an independent safety/quality review. It samples up to 180 evenly spaced messages, limits the model context, and redacts email addresses, phone numbers, payment-card-like numbers, US Social Security number patterns, and common street-address forms before sending text. A single writer repair pass is attempted when the reviewer requests revisions.

The selected model provider processes the redacted sample under its own data-handling terms. The original upload and full parsed chat are not sent to storage. The sampled, redacted messages and intermediate workflow results are persisted by Vercel Workflows while a job runs; on Hobby, workflow state is retained for up to one day. Completed reports are stored in private Vercel Blob when connected, otherwise in this browser’s local storage during local development. Blob reports remain until deleted; browser-local reports stay on that device. `ReportStorage` keeps browser history replaceable; a 256-bit device capability scopes private Blob access, but it is not account authentication or recovery.

The HTTP route only starts or checks a job. Each model request runs in a separate Workflow step with a 50-second timeout, so the orchestration does not depend on one long-running HTTP request and fits within Vercel Hobby’s function-duration limit. The browser polls job status; a run can take several minutes.

## Current scope

- WhatsApp `.txt` exports up to 1.5 MB and `.zip` archives up to 50 MB, with chat text limited to 1.5 MB
- ZIP archives must contain one chat `.txt` export; media and other archive files are ignored and not extracted
- Participant confirmation plus relationship, tone, and depth controls
- Five-part evidence pipeline with exact quote/source-ID validation and an independent reviewer
- Private Vercel Blob report history with open, delete, and delete-all controls; localStorage fallback outside Vercel Blob deployments
- Chat parsing, normalization, pipeline, and report schema tests via `npm test`
- Ten synthetic normalization evaluation fixtures; these are deterministic checks, not a substitute for ongoing human review of model quality

## Deploy to Vercel

1. Push this repository to GitHub. `.env.local`, other `.env.*` files, build output, and dependencies are excluded from Git; only `.env.example` is tracked.
2. Import the GitHub repository in Vercel and keep the detected Next.js build settings (`npm run build`).
3. In Vercel Storage, create and connect a **private** Blob store to the project. Enable access to Vercel system environment variables so the SDK can use the store’s `BLOB_STORE_ID` and Vercel OIDC. Do not make reports public.
4. Add `MODEL_API_URL`, `MODEL_API_KEY`, and `MODEL_NAME` as server-side environment variables in Vercel Project Settings. Add them to Preview and Production only when those environments should make real model requests. Never use a `NEXT_PUBLIC_` prefix for these secrets.
5. Deploy a Preview first and verify it with a synthetic chat before sending any real conversation.

GitHub Actions runs `npm ci`, the test suite, and a production build on pushes and pull requests using Node.js 22.

## Important deployment limits

The model stages execute as separate durable Workflow steps. Vercel Workflows require the Vercel system environment variables to be available so runs use Vercel’s durable backend rather than a local filesystem fallback. Vercel Hobby retains workflow state for up to one day; that state includes the redacted sample and intermediate model output.

Reports use private Blob objects under a SHA-256 namespace derived from a random key stored in the browser. The server never returns a Blob URL. This capability gives one browser access to its reports but is not user login: clearing browser storage or changing devices loses access, and anyone who steals the key can access that device’s reports.

There is no account authentication or distributed rate limiting. Anyone who can reach the analysis API could consume model quota by creating a new device key. Before public production access, add authentication and rate limiting (or another abuse gate). Until then, use Vercel Preview deployments protected by Vercel Deployment Protection; do not expose the model-backed API publicly.
