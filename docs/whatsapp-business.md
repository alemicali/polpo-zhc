# WhatsApp Business (Meta Cloud API)

A `whatsapp-business` channel connects a business phone number through Meta's official
WhatsApp Cloud API. It is separate from the `whatsapp` channel, which pairs a personal number
as a linked device over WhatsApp Web (QR code).

- **Customers** (the default audience) write to the number and are answered by one agent
  (`gateway.agent`), never by Polpo. They cannot use commands and are never told about pairing.
- **Operators** (`business.operators`) use commands and receive notifications.
- Free-form messages go out only inside the **24-hour window** that a contact's message opens.
  Outside it, only **approved templates** of the allowed categories, never to a contact who opted
  out, within the daily caps. When agents or Polpo send a template it waits for an operator's
  approval (`business.approveTemplates`, on by default).

One Meta app per instance: each instance has its own app, app secret and webhook. A Meta app
shared by several instances is not supported in this version.

## Configuration

```json
{
  "settings": {
    "notifications": {
      "channels": {
        "shop": {
          "type": "whatsapp-business",
          "phoneNumberId": "1234567890",
          "wabaId": "9876543210",
          "graphApiVersion": "v23.0",
          "business": {
            "audience": "customers",
            "operators": ["393331234567"],
            "markRead": true,
            "typing": true,
            "outsideWindow": "fail",
            "notificationTemplate": { "name": "ops_alert", "language": "it", "bodyParams": ["{title}", "{body}"] },
            "allowedCategories": ["UTILITY"],
            "approveTemplates": true,
            "limits": { "businessInitiatedPerDay": 50, "perAgentPerDay": { "support": 20 } },
            "retentionDays": 90
          },
          "gateway": { "enableInbound": true, "agent": "support" }
        }
      }
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `phoneNumberId`, `wabaId` | — | The phone number's id and the WhatsApp Business Account id (WhatsApp Manager → API setup). |
| `graphApiVersion` | `v23.0` | Graph API version. |
| `accessTokenRef`, `appSecretRef`, `verifyTokenRef` | the channel's entries | Vault references, owner `$channels`, service `whatsapp-business:<channel>:<kind>`. Written by the dashboard; never a secret in the configuration. Other owners are refused. |
| `business.audience` | `customers` | `customers`: anyone may write, `gateway.agent` (required) answers; `operators`: the team (allowlist). |
| `business.operators` | `[]` | Operators' wa_ids (phone numbers with country code, digits). |
| `business.markRead` / `typing` | `true` | Mark inbound messages read; show the typing indicator while the agent works. |
| `business.outsideWindow` | `fail` | A notification for someone outside the window: `template` (`notificationTemplate`) or `fail`. |
| `business.allowedCategories` | `["UTILITY"]` | Template categories agents and Polpo may send. |
| `business.approveTemplates` | `true` | Templates from agents and Polpo wait for an operator's approval. |
| `business.limits.businessInitiatedPerDay` | `50` | Business-initiated (template) messages per day (UTC) for the channel. |
| `business.limits.perAgentPerDay` | — | The same, per agent. |
| `business.retentionDays` | `90` | Messages older than this are deleted (contacts with no activity too; an opt-out is kept). |
| `gateway.commands` | `all` | Who may use slash commands: `all`, `operators`, `none`. Customers' channels always use operators-only. |

Secrets are entered in **Settings → Channels → the channel**: the access token, the app secret and
the verify token (or **Generate** one: it is shown once, to paste into Meta). They go to the vault
and are shown afterwards only as *stored* / *not set*. From MCP, `polpo_channel_save` creates the
channel and returns the setup link; `polpo_setup_wait { setup_ids: ["wabiz:<channel>:accessToken", …] }`
waits for them.

## Meta setup

1. **App.** In [Meta for Developers](https://developers.facebook.com/apps) create an app of type
   *Business* and add the **WhatsApp** product. Link it to your Business portfolio.
2. **Number.** In WhatsApp Manager add the phone number, verify it (SMS or call) and **register**
   it for the Cloud API with a two-step verification PIN (`POST /{phone-number-id}/register`
   with `{ "messaging_product": "whatsapp", "pin": "123456" }`, or from the dashboard). Copy the
   **phone number ID** and the **WhatsApp Business Account ID** into the channel.
3. **Token.** Business settings → System users: create a system user, assign it the app and the
   WhatsApp account, and generate a token (no expiry) with `whatsapp_business_messaging` and
   `whatsapp_business_management`. Paste it as the access token.
4. **App secret.** App → Settings → Basic → App secret. Paste it: every delivery is verified with
   it (`X-Hub-Signature-256`).
5. **Webhook.** App → WhatsApp → Configuration → Webhook: the **callback URL** shown in the channel
   (`<POLPO_PUBLIC_URL>/api/v1/channels/whatsapp-business/webhooks/<channel>`) and the **verify
   token**. Meta calls the URL at once; the channel's event log shows *Subscription verified*.
   Then subscribe the webhook field **messages**.
6. **Subscribe the app to the account**: `POST /{waba-id}/subscribed_apps` with the access token
   (without it no message reaches the webhook).
7. **Payment method.** Add one to the WhatsApp account (Business settings → WhatsApp accounts →
   Payment settings): business-initiated templates are paid.
8. **Templates.** Create them in WhatsApp Manager (utility for transactional updates) and wait for
   approval; **Sync** them in Polpo (or `polpo_wabiz_templates { refresh: true }`).
9. **Live mode.** Switch the app from Development to Live (it needs a privacy policy URL).

### Exposing the webhook (Tailscale Funnel)

Instances behind Tailscale Funnel expose only listed paths. Add the webhooks' path, per instance
(the instance's path prefix and its local port):

```sh
tailscale funnel --bg --set-path /<instance>/api/v1/channels/whatsapp-business/webhooks \
  http://127.0.0.1:<port>/api/v1/channels/whatsapp-business/webhooks
```

The channel shows the exact command. Nothing else of the instance is exposed by it.

## How messages flow

- **Inbound.** The webhook checks the signature over the raw body, refuses bodies over 1 MB and
  more than 600 deliveries a minute per channel (its own limit, outside the instance's per-IP one),
  ignores deliveries for another phone number, writes the delivery to the inbox
  (`.polpo/whatsapp-business-inbox/`) and answers 200. The inbox is then processed in order and
  drained again at start: nothing is lost across a restart, and processed keys (kept 7 days) make
  sure Meta's retries are not handled twice. Text, button and list replies reach the agent as text;
  other types arrive as a placeholder (`[immagine]`, `[documento]`…) in this version.
- **Replies** are free-form (inside the window by construction), split at 4096 characters, with
  Markdown turned into WhatsApp formatting. Read receipts and the typing indicator use the
  contact's last message.
- **Statuses** (sent, delivered, read, failed) update the message's history and pricing
  (category, billable) and are announced as `channel:message-status` on the event stream.
- **Opt-out.** A message that is only `STOP`, `STOP ALL`, `UNSUBSCRIBE`, `ANNULLA`, `DISISCRIVIMI`,
  `CANCELLAMI`, `BASTA`… records the opt-out and blocks business-initiated messages; `START`
  undoes it. Operators can record opt-in / opt-out (REST, dashboard).
- **Notifications** (rules, conversation pipes) go to the pipe's chat or to the operators: inside
  the window as text, outside it with `notificationTemplate` or not at all.

### Customer agents

The agent that answers customers should have **few tools**: what customers write is untrusted
input and may try to make the agent do things. Do not give it file, shell, vault or sending tools
it does not need; prefer read-only tools and a narrow system prompt.

Agents get the WhatsApp Business tools only when their `allowedTools` name them (`wabiz_*`, or
one by one): `wabiz_send` (inside the window), `wabiz_send_template`, `wabiz_templates`,
`wabiz_conversation`. `whatsapp_*` (the QR channel's tools) does not grant them.

## API, MCP, SDK

- REST (authenticated): `/api/v1/whatsapp-business` — status, `PUT /:name/secrets`,
  `POST /:name/verify-token`, events, contacts and conversations, opt-in, erase a contact,
  `send`, `send-template`, templates and sync, the approval queue (`pending`, approve, reject),
  `test` (quality rating and messaging tier when Graph returns them). See `docs/openapi.json`.
- MCP: `polpo_wabiz_status`, `polpo_wabiz_events`, `polpo_wabiz_templates`,
  `polpo_wabiz_conversation`, `polpo_wabiz_send`, `polpo_wabiz_send_template`,
  `polpo_wabiz_approval` (sends need `confirm: true` and the `polpo:messages` scope). Polpo's chat
  has them as `wabiz_*`.
- SDK: `client.getWaBusinessStatus()`, `sendWaBusinessTemplate()`…; React:
  `useWaBusinessStatus`, `useWaTemplates`, `useWaConversation`.

## Costs

Meta charges per delivered template message by category (marketing, utility, authentication)
and country; utility templates sent inside an open window and free-form replies are free. The
status webhooks carry the pricing category and whether the message was billable, kept with each
message. See Meta's pricing page for current rates.

## Data protection

- Messages and contacts are kept for `retentionDays` (default 90) and purged every 6 hours;
  processed webhook keys for 7 days. A contact and all its messages can be erased
  (`DELETE /api/v1/whatsapp-business/:name/contacts/:waId`).
- The event log never contains message text: types, lengths and masked numbers (`39•••••••567`).
- Record a lawful basis and the customer's opt-in before sending marketing templates; keep
  `allowedCategories` to `UTILITY` otherwise.

## Not in this version

Media (receiving and sending images, documents, audio), interactive messages and buttons sent by
agents, template headers and buttons with parameters, a Meta app shared by several instances,
flows, catalogs and payments, the MCP UI widgets.
