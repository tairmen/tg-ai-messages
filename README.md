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

If a login code does not arrive, use `npm run telegram:login -- --qr`. In the official Telegram mobile app for the account you want to connect, open Settings > Devices > Link Desktop Device and scan the terminal QR. A two-step password may still be required. QR tokens stay in your terminal and must be kept private. The phone-code flow reports the delivery method Telegram selected (app, SMS, or call).

## Environment

Copy `.env.example` to `.env` and populate it locally. Both `api_id`/`api_hash` and `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are supported. PostgreSQL database must already exist; migrations create the configured contacts table and three suffixed tables, without dropping existing data. Use a dedicated table name with at most 40 letters/numbers/underscores. `POSTGRES_SSL=true` enables verified TLS when your database requires it.

## Workflow

1. Log in through the terminal; the saved session is in `.data/telegram.session`. Do not share this file.
2. Add contacts or import a UTF-8 CSV with `name,phone` headers and international-format numbers.
3. Compose an individual message in Inbox, or save a campaign draft with up to 10 recipients. Review and confirm before sending. `{{name}}` is expanded per campaign recipient.
4. Configure instructions and a model in AI assistant. Use Draft with AI to review output. AI automation is off by default and requires both the global switch and the switch on each contact or group.
5. STOP, unsubscribe, стоп, and відписатися opt a contact out of further messages.

## Operational limits

- Local-only admin application. No remote authentication or multi-operator deployment is implemented. Do not expose the ports through a public proxy.
- Keep one app instance running per Telegram session. The process must be running to receive new messages or send AI replies. Immediate private replies handle registered, matched contacts. Scheduled private checks import the latest 30 messages; groups read the latest 30 messages directly from Telegram. Groups must first be discovered using Load Telegram groups or list_groups.
- Phone discovery and first messages depend on Telegram privacy and account restrictions. The app stops a campaign on Telegram flood/restriction errors; it does not bypass restrictions. Importing a contact uploads their number to Telegram.
- Campaigns are not retried automatically. Interrupted campaigns are marked on restart. If delivery succeeds but the database write fails, inspect Telegram before sending again. A saved result means Telegram accepted the send; it is not a read receipt.
- AI calls send up to 30 stored messages to OpenAI, with API response storage disabled. Model access depends on your API account. Default model is configurable. Replies can be inaccurate; review instructions and test with your own contact before enabling automation.
- The OpenAI key is never sent to the browser. `.env`, `.data/`, dependencies, and build output are excluded from Git.

## Checks

`npm run build` checks the frontend bundle. `npm test` runs backend validation tests. No real customer messages are sent by checks.

## AI for groups and private chats

In **AI assistant → AI for groups & private chats**, select a contact, or click **Load Telegram groups** and select a joined group. Load more pages if necessary. Save separate instructions, enable AI for that conversation, and select one mode:

- **Immediate**: evaluate on an incoming message. AI can reply or stay silent. Own outgoing messages do not trigger replies. New incoming messages invalidate a draft that is still being generated.
- **Scheduled**: evaluate periodically, even without new incoming messages. Set **Check every (minutes)** to **1** for a check every minute (up to 10080 minutes). This is a decision interval; it does not force a message every interval. To send each time, explicitly state that in the instructions.

Example instructions: “Check whether someone has asked a question that has remained unanswered for five minutes. If so, help using the business knowledge. Otherwise stay silent. Do not repeat an answer or reminder.” For time-based conditions, specify the timezone in the instructions. Recent history includes timestamps, group sender IDs, and your own outgoing messages.

The global AI switch must also be saved as enabled. No automation is enabled by adding this feature; existing per-contact permissions and immediate mode are preserved. New groups default to disabled. Empty conversation instructions use the global policy.

The application server must keep running. Each evaluation uses OpenAI API credits, including skipped sends. The first scheduled check is one interval after saving conversation settings. Next check and last decision/reason are persisted and visible using **Reload saved settings & status**. Missed checks are coalesced into one check after restart, without replaying every missed interval. Due checks share up to four workers; API latency and queueing may delay a check. Only one app instance should use a Telegram session.

Global pause, conversation disable, private opt-out, mode changes, and changed instructions are rechecked before sending. Scheduled private history imports also honor newly discovered STOP messages. If delivery becomes uncertain, AI for that conversation is disabled; inspect Telegram before enabling it again. API or parsing errors record an error without sending. Auto decisions use the Responses API [structured output format](https://developers.openai.com/api/docs/guides/structured-outputs); choose a model that supports it.

### MCP configuration

- `set_contact_preferences`: now also accepts `ai_mode` (`immediate` or `scheduled`) and `ai_interval_minutes` (integer, 1–10080), along with `ai_enabled` and `ai_instructions`.
- `get_group_ai_settings`: read group configuration, global switch, next check and last decision using `group_id` from `list_groups`.
- `set_group_preferences`: configure the same AI fields for a group. Enabling it authorizes future automatic posts under the saved instructions, so only do this when requested.
- `get_conversation`, `list_conversations`, and `list_contacts` expose private AI configuration and status.

For example, configure a discovered group with `{"group_id":12,"ai_enabled":true,"ai_mode":"scheduled","ai_interval_minutes":1,"ai_instructions":"Help with unanswered questions; otherwise stay silent."}` using `set_group_preferences`. This does not change the global switch.

Restart the server to apply the additive database migration automatically, or run `npm run db:migrate` before restarting. Rebuild the dashboard with `npm run build`. Refresh/reconnect your MCP client if its cached tool list does not show the two new group tools (21 tools total).
