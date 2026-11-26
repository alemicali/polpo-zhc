# WhatsApp Business (Meta Cloud API)

A `whatsapp-business` channel connects a business phone number through Meta's official
WhatsApp Cloud API. It is separate from the `whatsapp` channel, which pairs a personal number
as a linked device over WhatsApp Web (QR code).

- **Customers** (the default audience) write to the number and are answered by one agent
  (`gateway.agent`), never by Polpo. They cannot use commands and are never told about pairing.
- **Operators** (`business.operators`) use commands and receive notifications.
- Free-form messages of every type (text, media, buttons, lists, flows, products…) go out only
  inside the **24-hour window** that a contact's message opens. Outside it, only **approved
  templates** of the allowed categories, never to a contact who opted out, within the daily caps.
  When agents or Polpo send a template it waits for an operator's approval
  (`business.approveTemplates`, on by default).

One Meta app can serve several numbers: several channels of one instance, and several instances
(see [One Meta app, several instances](#one-meta-app-several-instances)). The
[support matrix](#support-matrix) lists every Cloud API capability and its status.

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
            "retentionDays": 90,
            "media": { "download": true, "maxBytes": 16777216 },
            "catalogId": "1122334455",
            "marketingMessagesApi": false,
            "appId": "5566778899",
            "sharedApp": { "routes": { "1234567899": "https://other.example.ts.net/acme2/api/v1/channels/whatsapp-business/webhooks/shop" } }
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
| `business.retentionDays` | `90` | Messages and their files older than this are deleted (contacts with no activity too; an opt-out is kept). |
| `business.media.download` | `true` | Download inbound media (photos, voice notes, audio, video, documents, stickers) and keep them with the message; off: only type, size and caption are kept. |
| `business.media.maxBytes` | 16 MB | The largest inbound file kept (Meta's own limits per type apply too: images 5 MB, audio and video 16 MB, documents 100 MB, stickers 500 KB). |
| `business.catalogId` | — | The Commerce catalog connected to the account: the default for product, product list and catalog messages. |
| `business.payments` | — | Payments inside WhatsApp (`order_details`): `{ "market": "IN", "configurationName": "…" }` (India: payment gateway or UPI configuration) or `{ "market": "BR" }` (Brazil: Pix, boleto, payment links). Meta offers payments only there: anything else is refused. |
| `business.marketingMessagesApi` | `false` | Marketing templates go through the Marketing Messages API (`POST /{phone-number-id}/marketing_messages`); the account must be onboarded to it. |
| `business.appId` | — | The Meta app's id: needed only to upload the business profile photo (Resumable Upload API). |
| `business.sharedApp.routes` | `{}` | One Meta app shared by several instances: `phone_number_id → that instance's webhook URL (https)`; see below. |
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
   it for the Cloud API with a two-step verification PIN (from the channel's *Phone number* panel,
   `POST /api/v1/whatsapp-business/:name/phone { action: "register", pin }`, or
   `polpo_wabiz_phone`). Copy the **phone number ID** and the **WhatsApp Business Account ID**
   into the channel.
3. **Token.** Business settings → System users: create a system user, assign it the app and the
   WhatsApp account, and generate a token (no expiry) with `whatsapp_business_messaging` and
   `whatsapp_business_management` (and `catalog_management` for product messages). Paste it as
   the access token.
4. **App secret.** App → Settings → Basic → App secret. Paste it: every delivery is verified with
   it (`X-Hub-Signature-256`).
5. **Webhook.** App → WhatsApp → Configuration → Webhook: the **callback URL** shown in the channel
   (`<POLPO_PUBLIC_URL>/api/v1/channels/whatsapp-business/webhooks/<channel>`) and the **verify
   token**. Meta calls the URL at once; the channel's event log shows *Subscription verified*.
   Then subscribe the webhook fields: **messages** (messages, statuses, payments, marketing
   preferences) and, for the account log, **account_update**, **account_alerts**,
   **account_review_update**, **business_capability_update**, **phone_number_name_update**,
   **phone_number_quality_update**, **message_template_status_update**,
   **message_template_quality_update**, **message_template_components_update**,
   **template_category_update**, **security**.
6. **Subscribe the app to the account** (*Subscribe app* in the channel, or
   `POST /{waba-id}/subscribed_apps`): without it no message reaches the webhook.
7. **Payment method.** Add one to the WhatsApp account (Business settings → WhatsApp accounts →
   Payment settings): business-initiated templates are paid.
8. **Templates.** Create them in WhatsApp Manager or from Polpo (dashboard, `POST /templates`,
   `polpo_wabiz_template_manage`): utility for transactional updates. They go to Meta's review;
   the result comes back by webhook (`message_template_status_update`) and the list is synced again.
9. **Catalog, flows, payments (optional).** Connect a Commerce catalog to the account
   (`business.catalogId`); publish flows in WhatsApp Manager → Flows; payments only in India and
   Brazil (`business.payments`).
10. **Live mode.** Switch the app from Development to Live (it needs a privacy policy URL).

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
  writes the delivery to the inbox (`.polpo/whatsapp-business-inbox/`) and answers 200. The inbox
  is then processed in order and drained again at start: nothing is lost across a restart, and
  processed keys (kept 7 days) make sure Meta's retries are not handled twice. Deliveries for
  another number are routed (see below) or ignored.
- **Every inbound type** is normalized: text; **media** (image, audio, voice note, video,
  document, sticker) downloaded with the token **only from Meta's hosts** (`graph.facebook.com`,
  `lookaside.fbsbx.com`, https, no redirects), within Meta's and the channel's size limits, kept
  under `.polpo/whatsapp-business/media/<channel>/` for the retention and handed to the agent as
  attachments (voice notes and audio are **transcribed** on arrival with the speech-to-text key, as
  on Telegram; a file that was not kept is described to the agent with the reason); location;
  shared contacts; replies to **buttons**, **lists** and template quick replies (the title with the
  chosen id); **flow completions** (`nfm_reply`: the answers as structured data with the
  `flow_token`); **address** answers; **call permission** answers; **orders** from the catalog
  (items, quantities, prices, total); product enquiries; the first-open welcome
  (`request_welcome`); system notices. Quoted messages (`context.id`), forwarded / frequently
  forwarded flags, referred products and click-to-WhatsApp ad referrals are kept and shown to the
  agent. **Reactions**, **edits** and **revokes** change the message they refer to (a revoked
  message loses its text and its file).
- **Structured events.** Flows, orders, payments, button / list replies, addresses, call
  permissions, locations, shared contacts, media, reactions, marketing preferences and account
  updates are announced as `channel:wabiz-event` (`{ channel, kind, contact (masked), messageId,
  data }`) on the event stream: a trigger or a hook can act on a completed flow or an order.
- **Replies** go out inside the window by construction: text split at 4096 characters with
  Markdown turned into WhatsApp formatting; the agent's reply buttons as interactive **reply
  buttons** (up to 3, 20 characters) or a **list** (up to 10 rows); its files as media (image,
  audio, video or document by type and size); a voice reply as audio. Read receipts and the typing
  indicator use the contact's last message.
- **Statuses** (sent, delivered, read, failed, deleted) update the message's history, pricing
  (category, type, billable, pricing model) and error (code, title, details) in the conversation
  log, and are announced as `channel:message-status`. A **marketing preference**
  (`user_preferences`: the person stopped or resumed marketing messages from WhatsApp itself) is
  kept on the contact: no marketing template goes to someone who stopped them. **Payment** statuses
  (India) are kept in the conversation, announced and handed to the agent.
- **Opt-out.** A message that is only `STOP`, `STOP ALL`, `UNSUBSCRIBE`, `ANNULLA`, `DISISCRIVIMI`,
  `CANCELLAMI`, `BASTA`… records the opt-out and blocks business-initiated messages; `START`
  undoes it. Operators can record opt-in / opt-out (REST, dashboard, MCP).
- **Notifications** (rules, conversation pipes) go to the pipe's chat or to the operators: inside
  the window as text, outside it with `notificationTemplate` or not at all.

## Sending: every type, every rule

| Path | Rules |
| --- | --- |
| Text, media, location, contact cards, reactions, interactive (reply buttons, list, CTA URL, location request, call button, call permission request, address request), flows, product, product list, catalog, order details / status | Only inside the 24-hour window (Meta's 131047 maps to the same error), never to a blocked contact; checked against Meta's limits before Meta is called (characters, counts, unique ids, media types and sizes, https links). |
| Templates (business-initiated) | Approved; every variable of the template's definition filled and nothing extra; an allowed category; never to someone who opted out, nor marketing to someone who stopped marketing messages; the daily caps (channel, per agent); from agents and Polpo they wait for an operator's approval (`business.approveTemplates`), and the rules are checked again on approval. |

Media go out by **upload** (`POST /{phone-number-id}/media`, multipart; the file is checked against
Meta's type and size for its kind first and kept for the conversation view), by a public **https
link**, or by a Meta **media id**, with a caption (images, videos, documents) and a file name
(documents).

**Templates with every component** (`components` in REST, MCP and the agent tool):

```json
{
  "header": { "type": "image", "link": "https://…/box.jpg" },
  "body": { "name": "Mario", "order": "A12" },
  "buttons": [{ "index": 0, "text": "A12" }, { "index": 1, "payload": "STOP" }],
  "carousel": [{ "header": { "type": "image", "mediaId": "…" }, "body": ["…"], "buttons": [{ "index": 0, "payload": "…" }] }],
  "offerExpiresAt": "2026-11-30T23:00:00Z",
  "otp": "482913"
}
```

Headers: text (with its variable), image, video, document (by link or media id, with a file name)
or location. Body: a list for positional `{{1}}` variables, an object for named `{{name}}` ones.
Buttons by their index: a URL's variable suffix (`text`), a quick reply's `payload`, a copy-code
`couponCode` (≤ 15), a flow's `flowToken` / `flowActionData`, catalog and multi-product `action`;
phone buttons take nothing. Carousel cards in order. Authentication templates: `otp` fills the body
and the copy-code / one-tap / zero-tap button. `wabiz_templates` and `GET /templates` say what each
template needs; anything missing or extra is refused before Meta is called.

**Template management**: create (name, language, category, Meta's components with examples,
`parameterFormat` POSITIONAL / NAMED), edit (components or category: back to review), delete
(every language, or one by id). Status, quality and category changes arrive by webhook in the
account log and refresh the list.

### Customer agents

The agent that answers customers should have **few tools**: what customers write is untrusted
input and may try to make the agent do things. Do not give it file, shell, vault or sending tools
it does not need; prefer read-only tools and a narrow system prompt.

Agents get the WhatsApp Business tools only when their `allowedTools` name them (`wabiz_*`, or
one by one): `wabiz_send` (text inside the window), `wabiz_send_media` (a file of the agents'
workspace — never `.polpo` —, a link or a media id), `wabiz_send_interactive` (buttons, list, CTA
URL, location request, location, contact cards, call button, call permission request, address
request), `wabiz_send_flow`, `wabiz_send_products`, `wabiz_send_order`, `wabiz_react` (a reaction or
mark read), `wabiz_send_template` (every component; queued for approval), `wabiz_templates` (with
what each needs), `wabiz_conversation`. In a turn that came from a WhatsApp Business chat, `to`
and `channel` default to that chat. `whatsapp_*` (the QR channel's tools) does not grant them.

## Account management

- **Business profile**: about (≤ 139), description (≤ 512), address, email, up to 2 websites,
  vertical, photo (JPEG / PNG ≤ 5 MB through the Resumable Upload API: `business.appId`).
- **Phone number**: display name and its review status, quality rating, messaging limit tier,
  throughput, mode; **register** (with the two-step PIN), **deregister**, **set the two-step PIN**,
  **request / verify a code** (SMS or voice), **subscribe the app** to the account, the **webhook
  override**.
- **Blocked users**: block (Meta allows it only for people who wrote in the last 24 hours), unblock,
  list; a blocked contact gets nothing from Polpo either.
- **Analytics**: messages (sent and delivered per half hour, day or month), pricing (cost and
  volume per category, country, tier…), templates (sent, delivered, read, clicked; 90 days).
- **Account log**: `account_update`, `account_alerts`, `account_review_update`,
  `business_capability_update`, `phone_number_name_update`, `phone_number_quality_update`,
  `message_template_status_update`, `message_template_quality_update`,
  `message_template_components_update`, `template_category_update`, `security` — one line each,
  kept per channel (`GET /:name/account-events`) and announced as `channel:wabiz-event` kind
  `account`; quality, tier and name changes refresh the number's status.

## One Meta app, several instances

A Meta app has one webhook callback, but each **phone number** can have its own (**webhook
override**). Two ways:

1. **Per-number override (recommended).** On each instance, **Point this number here**
   (dashboard, `PUT /:name/webhook-override { set: true }`, `polpo_wabiz_phone { action:
   "override_webhook" }`): Meta then delivers that number's messages to that instance's callback,
   checked with its verify token. The app secret (the same for every number of the app) goes into
   each instance's vault through the dashboard; no token is shared between instances.
2. **Routing.** The instance that owns the app's callback routes by `phone_number_id`: a delivery
   for another channel of the same instance is handled as that channel's; one for a number listed
   in `business.sharedApp.routes` is **forwarded unchanged** (the raw body and its
   `X-Hub-Signature-256`, never the access token) to that instance's https webhook, which verifies
   the signature itself with the same app secret. Anything else is recorded as *another phone
   number* and ignored.

Account-level fields are recorded once, by the channel Meta called. Every routing decision is in
the event log.

## API, MCP, SDK

- REST (authenticated): `/api/v1/whatsapp-business` — status, `PUT /:name/secrets`,
  `POST /:name/verify-token`, events, account events, contacts and conversations, opt-in, erase a
  contact, `send` (text), `messages` (any type, with an optional base64 file up to 20 MB), `react`,
  `read`, `media/:messageId` (a message's file), `send-template` (with `components`), templates
  (list, sync, create, edit, delete), the approval queue (`pending`, approve, reject), `profile`,
  `block` / `blocked`, `analytics`, `phone`, `webhook-override`, `test`. See `docs/openapi.json`.
- MCP, `channels` toolset (on by default): `polpo_wabiz_status`, `polpo_wabiz_events`,
  `polpo_wabiz_templates`, `polpo_wabiz_conversation`, `polpo_wabiz_send`,
  `polpo_wabiz_send_template` (every component), `polpo_wabiz_approval` (sends need
  `confirm: true` and the `polpo:messages` scope), `polpo_wabiz_contact` and
  `polpo_wabiz_contact_erase` (`polpo:admin`). `polpo_message_send { channel: "whatsapp-business",
  to }` sends free-form text inside the window.
- MCP, **`whatsapp-business` toolset** (off by default — the default toolsets are at the
  client-side tool limit; enable it with `settings.mcp.toolsets: ["default", "whatsapp-business"]`
  or `POLPO_MCP_TOOLSETS=default,whatsapp-business`): `polpo_wabiz_send_media`,
  `polpo_wabiz_send_interactive`, `polpo_wabiz_send_flow`, `polpo_wabiz_send_products`,
  `polpo_wabiz_send_order`, `polpo_wabiz_react` (sends: `confirm: true`, `polpo:messages`),
  `polpo_wabiz_template_manage`, `polpo_wabiz_profile`, `polpo_wabiz_block`, `polpo_wabiz_phone`
  (changes: `confirm: true`, `polpo:admin`), `polpo_wabiz_analytics`, and the
  **`polpo_wabiz_show` card** (an MCP App): the channel's status, recent conversations with photo
  thumbnails, a conversation's transcript drawn as WhatsApp bubbles (photos, voice notes,
  documents, buttons, lists, links, flows, products, orders, reactions, ticks) and the templates
  waiting for approval with **Approve** / **Reject** (the click is the person's decision).
- Polpo's chat has every one of them as `wabiz_*` (whatever the instance's MCP toolsets).
- Dashboard: the channel's sheet — status, secrets, event log, account log, contacts with their
  conversation (media, interactive and template messages, reactions, ticks), a composer for every
  type inside the window and for templates with every component, template management, profile,
  phone number, blocked users, analytics, approvals.
- SDK and React: a method for every endpoint and hooks (`useWaBusinessStatus`, `useWaTemplates`,
  `useWaConversation`, `useWaContacts` and the account ones), live over `channel:webhook`,
  `channel:message-status` and `channel:wabiz-event`.

## Costs

Meta charges per delivered template message by category (marketing, utility, authentication)
and country; utility templates sent inside an open window and free-form replies are free. The
status webhooks carry the pricing category and whether the message was billable, kept with each
message; the pricing analytics give the totals. See Meta's pricing page for current rates.

## Data protection

- Messages, contacts and media files are kept for `retentionDays` (default 90) and purged every 6
  hours; processed webhook keys for 7 days. A contact, all its messages and its files can be erased
  (`DELETE /api/v1/whatsapp-business/:name/contacts/:waId`).
- The event log never contains message text: types, lengths and masked numbers (`39•••••••567`);
  structured events carry masked numbers too.
- Media are downloaded only from Meta's hosts with the token, and served to the dashboard only to
  authenticated callers (`nosniff`).
- Record a lawful basis and the customer's opt-in before sending marketing templates; keep
  `allowedCategories` to `UTILITY` otherwise.

## Support matrix

✅ implemented · ⛔ not available in the Cloud API (or to businesses) · 🌍 market-restricted by Meta · ➖ outside Polpo's channel

| Capability | Status | Notes |
| --- | --- | --- |
| Text in / out, quoting (`context`), link preview | ✅ | Split at 4096 characters. |
| Images, audio, voice notes, video, documents, stickers — in | ✅ | Meta's hosts only, size limits per type, kept for the retention; voice notes transcribed. |
| Images, audio, video, documents, stickers — out | ✅ | Upload, link or media id; caption, file name. |
| Location, contact cards — in / out | ✅ | |
| Reactions — in / out | ✅ | Kept on the message. |
| Mark read, typing indicator | ✅ | |
| Statuses (sent, delivered, read, failed), pricing, errors | ✅ | In the conversation log and on the event stream. |
| Forwarded / frequently forwarded, referred product, ad referral | ✅ | |
| The contact's edits and revokes | ✅ | As Meta sends them (`edit`, `revoke`). |
| Editing or deleting a message the business sent | ⛔ | No such Cloud API endpoint. |
| Reply buttons, lists, CTA URL, location request | ✅ | Replies as structured events. |
| Address request (`address_message`) | 🌍 | India only. |
| Call button (`voice_call`), call permission request | ✅ | The Calling API must be enabled on the number; the calls themselves (SIP / WebRTC) ➖. |
| Flows: send published (or draft) flows; completions as structured data | ✅ | Building flows and a flow data endpoint stay in WhatsApp Manager ➖. |
| Template headers (text, image, video, document, location), positional and named variables | ✅ | Checked against the definition. |
| Template buttons: quick reply, URL suffix, copy code, OTP (copy code, one-tap, zero-tap), phone, flow, catalog, multi-product | ✅ | |
| Carousels, limited-time offers | ✅ | |
| Template management; status, quality, category, components webhooks | ✅ | |
| Product, product list, catalog messages; orders in | ✅ | A catalog connected to the account. |
| Payments (`order_details`, `order_status`, payment statuses) | 🌍 | India (payment gateway / UPI) and Brazil (Pix, boleto, payment links) only. |
| Marketing Messages API | ✅ | Onboarded accounts (`business.marketingMessagesApi`). |
| Business profile (about, description, address, email, websites, vertical, photo) | ✅ | Photo: `business.appId`. |
| Display name and its review, quality rating, messaging tier, throughput | ✅ | Read and announced; requesting a new display name is done in WhatsApp Manager ⛔. |
| Register / deregister, two-step PIN, request / verify code, subscribe the app | ✅ | |
| Block / unblock / list blocked users | ✅ | |
| Messages, pricing and template analytics | ✅ | |
| Account webhooks (update, alerts, review, capabilities, name, quality, templates, security) | ✅ | Account log and events. |
| Marketing preferences (`user_preferences`) | ✅ | Stops marketing templates. |
| Business-scoped user ids (no phone number) | ✅ | Sent as `recipient`. |
| One Meta app, several numbers / instances | ✅ | Per-number webhook override, or routing by `phone_number_id`. |
| Groups | ➖ | The Groups API (eligible accounts) is not part of this channel. |
| Status updates, polls, view-once media | ⛔ | Not passed to businesses (they arrive as `unsupported`). |
| MCP UI card with approvals (`polpo_wabiz_show`) | ✅ | |
