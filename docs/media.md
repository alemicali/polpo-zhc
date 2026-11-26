# Media

Image generation and editing are a **primitive**: one service, through the instance's image model,
used by every surface. Agents' tools, Polpo's chat, MCP, the REST API, missions and playbooks are
thin wrappers over it: no surface calls an image provider itself.

```
generateImage({ prompt, size?, n?, model?, referenceImages?, seed?, providerOptions? })
editImage({ image, prompt, mask?, size?, n?, model?, providerOptions? })
  → { id, kind, model, usedFallback, images: [{ index, path, file, url, mimeType, bytes, width, height, sha256 }], costUsd, latencyMs, warnings }
```

Every image is kept on the instance with its **provenance**, and every request is in the **media log**.

## The image model

`settings.imageModel` and `settings.media` in `.polpo/polpo.json` (Settings → **Media**):

```jsonc
"imageModel": "vercel-ai-gateway:openai/gpt-image-2",     // gateway:provider/model (a bare provider/model is on Vercel AI Gateway)
"media": {
  "fallbackModel": "vercel-ai-gateway:bfl/flux-2-pro",     // tried once when the model fails (an upstream error, not an invalid request)
  "credentialRef": { "owner": "polpo-infra", "service": "vercel-ai-gateway" },  // the gateway key in the vault
  "credentialField": "token",                               // default: apiKey, key or token
  "maxImages": 4,                                           // per request (at most 10)
  "retention": 1000, "retentionDays": 90                    // the media log (0 days: no age limit)
}
```

`settings.imageModel` used to be listed in Settings as a vision model but was never used; it is now
the image generation model. A request may pass its own `model` (the configured key is used for it).

### The gateway and the endpoint

Images go through the **shared gateway resolver** (`@polpo-ai/core` `gateways.ts`), like decisions:
the gateway's base URL, the only hosts its key may be sent to (`ai-gateway.vercel.sh`, https, no
redirects), and the key — the vault entry chosen in `settings.media`, else `AI_GATEWAY_API_KEY`. A
chosen entry that is missing is an error, never silently replaced. The key is never logged, returned
or put in an error; `GET /api/v1/media/status` says where it comes from.

The wire shape is the **OpenAI-compatible Images API that Vercel AI Gateway documents**
(<https://vercel.com/docs/ai-gateway/modalities/image-generation/openai>):

- `POST https://ai-gateway.vercel.sh/v1/images/generations` `{ model, prompt, n, size?, response_format: "b64_json", seed?, providerOptions? }`
- `POST https://ai-gateway.vercel.sh/v1/images/edits` (JSON form) `{ model, prompt, n, images: [{ image_url }], mask?: { image_url }, size?, … }`
  — images as `data:` URLs (or https URLs given by the caller); up to 16 images are composed.
- → `{ data: [{ b64_json | url, revised_prompt? }], usage?, providerMetadata?.gateway.cost }`.

Why not the AI SDK (`experimental_generateImage` with `gateway.imageModel()`): `@ai-sdk/gateway`
posts to its own internal protocol endpoint (`/v3/ai/image-model` with `ai-image-model-specification-version`
headers), not the documented public API, and its fetch would bypass the resolver's host allowlist and
no-redirect rule. One `fetch` through `gatewayUrl()` keeps the same tested path as decisions.

`seed` is sent as the gateway's `seed` field (models that do not support it report a warning,
kept in the log). Generating with `referenceImages` goes to the edits endpoint, the documented way
to give a model source images. Masks: models without mask support ignore the mask or fail.

### Without an image model

Every surface answers **409 `NOT_CONFIGURED`** with a link to Settings (`/config?section=media`).

## Assets and provenance

Each request is one entry of the media log, its images (the **variants**) grouped under it:

```
.polpo/media/
  index.json                    entries, newest first (pruned by retention: entries and their images)
  log/<img_id>.json             one entry
  images/<img_id>/<n>.<ext>     the images (png, jpg, webp, gif by their bytes) and <n>.thumb.webp (512 px previews)
  nodes.json                    missions' image nodes
```

An entry keeps who asked (`caller`: `api`, `mcp`, `chat`, `agent` + its name, its `taskId`,
`missionId` or chat `sessionId`, `mission` for an image node, the person `by`), the prompt (capped
at 8 000 characters), the model that answered (and whether the fallback did), the size, `n`, the
seed, the inputs (described, never their bytes), the latency, the usage, the cost, warnings and
each image's path, type, size, dimensions and sha256. The images are files of the instance's
`.polpo` folder (the Files page shows them) and are served by `GET /api/v1/media/images/{id}/{index}`.
An agent's tool also copies them to the path it asked for in its workspace (those copies stay when
the log entry is pruned).

The gateway's usage and cost are recorded as **token usage** with source `image`, like every model
call. Event `media:generated` on every logged request.

## Surfaces

- **REST**: `POST /api/v1/media/images` (generate), `POST /api/v1/media/images/edits`,
  `GET /api/v1/media/images` (the log: `limit`, `cursor`, `caller`, `callerId`, `status`, `kind`),
  `GET /api/v1/media/images/{id}`, `GET /api/v1/media/images/{id}/{index}` (`?thumb=1`, `?download=1`),
  `GET /api/v1/media/status`, `GET /api/v1/media/nodes`. Errors: 400 invalid (with `details`), 409 not
  configured (or the key is missing), 429 the gateway's rate limit, 502 the model failed, 504 too slow
  (180 s). Image requests are rate limited (30 a minute).
- **MCP**: `polpo_image_generate`, `polpo_image_edit` (work scope), `polpo_media_log`,
  `polpo_media_status` (read) and the **media card** `polpo_image_show` (an MCP App: the previews as
  `data:` images inside the card, prompt, model, cost, who asked; or the latest requests).
- **Polpo's chat**: `image_generate`, `image_edit`, `media_log`, `media_status` (the *media* tool group).
- **Agents**: `image_generate` and `image_edit`, given with their name (or `image_*`) in `allowedTools`:
  - `image_generate { prompt, path, size?, n?, seed?, model?, reference_images? }` — the old parameters
    still work; `model` takes `gateway:provider/model`; the old fal.ai ids (`fal-ai/flux/dev`…) are no
    longer called directly: the instance's model answers and the result says so;
    `num_inference_steps` and `guidance_scale` are ignored. Several images: `path`, `path-2`, `path-3`…
  - `image_edit { image (or a list), prompt, path, mask?, size?, n?, model? }` (workspace files).
  - `image_analyze { path, prompt?, provider?, model? }` is **not** a media model call: it is a turn of
    the chat pipeline with the image attached, without tools — the agent's own model by default (it must
    see images), or `provider:model` named in the call. Its usage is a chat's.
- **SDK**: `client.generateImage`, `editImage`, `getMediaLog`, `getMediaEntry`, `getMediaStatus`,
  `getImageNodes`, `mediaImageUrl`; React `useGenerateImage`, `useMediaLog`.
- **Dashboard**: **Media** (try a prompt with size, variants and seed; the history with previews and
  provenance; downloads) and Settings → **Media**.

## Image nodes in missions and playbooks

A mission (or a playbook's mission) can have `images`: after some tasks, an image is generated from
their results and given to later tasks — e.g. a form fills a playbook, an agent writes the post, an
image is made from it, another agent sends both on Telegram.

```jsonc
{
  "tasks": [
    { "title": "Write", "description": "Write a Telegram post about {{product}}" },
    { "title": "Send", "description": "Send the post with its image to the channel", "dependsOn": ["Write"] }
  ],
  "images": [{
    "name": "cover",
    "afterTasks": ["Write"],
    "prompt": "A bright, simple cover image for this post: {{tasks.Write}}",
    "forTasks": ["Send"],
    "size": "1024x1024",
    "onError": "continue"
  }]
}
```

- **When**: the `forTasks` wait; once every after task has finished, the prompt is rendered
  (`{{tasks.<title>}}` is that task's result; in playbooks this placeholder is reserved for run time,
  other `{{…}}` are the playbook's parameters) and the image is generated (caller `mission`).
- **Then**: each waiting task gets `## Image "<name>"` in its description with the files' paths and
  API URLs, then runs. `onError: "continue"` (default): the tasks run, told the image failed;
  `"fail"`: they fail with the reason.
- `size`, `n` and `model` override the defaults. The node's state survives restarts
  (`.polpo/media/nodes.json`); an image cut short by a restart is generated again. Event `media:node`.

## Trying it on an instance

```bash
# the instance's API key (Settings → MCP access / API keys), never printed in logs
curl -sS https://<host>/<instance>/api/v1/media/status -H "Authorization: Bearer $POLPO_API_KEY" | jq   # the model and where the key comes from

curl -sS https://<host>/<instance>/api/v1/media/images \
  -H "Authorization: Bearer $POLPO_API_KEY" -H 'content-type: application/json' \
  -d '{ "prompt": "A lighthouse at dawn, watercolor", "size": "1024x1024", "n": 1 }' | jq '.data | {id, model, costUsd, images: [.images[] | {index, url, bytes, width, height}]}'

# the image itself (id from above)
curl -sS -o lighthouse.png https://<host>/<instance>/api/v1/media/images/<img_id>/0 -H "Authorization: Bearer $POLPO_API_KEY"

curl -sS 'https://<host>/<instance>/api/v1/media/images?limit=5' -H "Authorization: Bearer $POLPO_API_KEY" | jq '.data.entries[] | {id, caller, model, costUsd, prompt}'
```

## Next

- **Video and audio** keep their tools as they are (`video_generate` through fal.ai, now in
  `video-tools.ts`; `audio_speak` / `audio_transcribe`). They will move onto the same shape:
  `generateVideo` / `speak` / `transcribe` through the gateway resolver, assets with provenance in the
  media log, cost as model usage, the same surfaces.
- Image nodes are not drawn in the mission and playbook graphs yet (decision nodes are).
- Fal models through Vercel AI Gateway: when the gateway lists them (Image Gen filter), they are just
  another `gateway:provider/model`.
