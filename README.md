# Relay — Telegram customer workspace

Local React + Mantine dashboard, Express API, PostgreSQL, teleproto, and OpenAI Responses API.

## Run

```powershell
npm install
npm run db:migrate
npm run telegram:login
npm run dev
```

Open http://127.0.0.1:5173. For a production build on this computer: `npm run build` then `npm start`, and open http://127.0.0.1:3001.

## Environment

Copy `.env.example` to `.env` and populate it locally. Both `api_id`/`api_hash` and `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are supported. PostgreSQL database must already exist; migrations create the configured contacts table and three suffixed tables, without dropping existing data. Use a dedicated table name with at most 40 letters/numbers/underscores. `POSTGRES_SSL=true` enables verified TLS when your database requires it.

## Workflow

1. Log in through the terminal; the saved session is in `.data/telegram.session`. Do not share this file.
2. Add contacts or import a UTF-8 CSV with `name,phone` headers and international-format numbers.
3. Compose an individual message in Inbox, or save a campaign draft with up to 10 recipients. Review and confirm before sending. `{{name}}` is expanded per campaign recipient.
4. Configure instructions and a model in AI assistant. Use Draft with AI to review output. Automatic replies are off by default and require both global and per-contact switches.
5. STOP, unsubscribe, стоп, and відписатися opt a contact out of further messages.

## Operational limits

- Local-only admin application. No remote authentication or multi-operator deployment is implemented. Do not expose the ports through a public proxy.
- Keep one app instance running per Telegram session. The process must be running to receive new messages or send AI replies. Existing Telegram chat history is not imported; only messages processed by this app are stored. Only registered, matched contacts are handled.
- Phone discovery and first messages depend on Telegram privacy and account restrictions. The app stops a campaign on Telegram flood/restriction errors; it does not bypass restrictions. Importing a contact uploads their number to Telegram.
- Campaigns are not retried automatically. Interrupted campaigns are marked on restart. If delivery succeeds but the database write fails, inspect Telegram before sending again. A saved result means Telegram accepted the send; it is not a read receipt.
- AI calls send up to 30 stored messages to OpenAI, with API response storage disabled. Model access depends on your API account. Default model is configurable. Replies can be inaccurate; review instructions and test with your own contact before enabling automation.
- The OpenAI key is never sent to the browser. `.env`, `.data/`, dependencies, and build output are excluded from Git.

## Checks

`npm run build` checks the frontend bundle. `npm test` runs backend validation tests. No real customer messages are sent by checks.
