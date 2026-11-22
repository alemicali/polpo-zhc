import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  memberKey,
  readMemberPreferences,
  SHARED_MEMBER_KEY,
  updateMemberPreferences,
  type MemberPreferences,
} from "../member-preferences-store.js";

const id = z.string().min(1).max(200);

const chatNavigationSchema = z.object({
  lastSessionId: id.nullable().optional(),
  lastRoomId: id.nullable().optional(),
  lastAgent: z.string().min(1).max(200).nullable().optional(),
  openTabs: z.array(id).max(50).optional(),
  sidePanelOpen: z.boolean().optional(),
  threadsOpen: z.boolean().optional(),
}).strict();

const preferencesSchema = z.object({
  chatNavigation: chatNavigationSchema.extend({ updatedAt: z.string().optional() }).optional(),
}).openapi("MemberPreferences");

const patchSchema = z.object({
  chatNavigation: chatNavigationSchema.optional(),
}).strict();

const responseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    /** Signed-in member the preferences belong to; null when shared (no instance auth). */
    member: z.string().nullable(),
    preferences: preferencesSchema,
  }),
});

export interface PreferencesRouteDeps {
  polpoDir: () => string;
  /** Email of the signed-in member, if any. */
  member: (c: Context) => string | undefined;
}

/** Per-member dashboard preferences (chat navigation: open chat, tabs, panels). */
export function preferencesRoutes(deps: PreferencesRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use("*", bodyLimit({ maxSize: 16 * 1024 }));

  const respond = (c: Context, key: string, preferences: MemberPreferences) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, data: { member: key === SHARED_MEMBER_KEY ? null : key, preferences } }, 200);
  };

  app.openapi(createRoute({
    method: "get", path: "/", tags: ["Preferences"],
    summary: "Get the signed-in member's dashboard preferences",
    responses: { 200: { description: "Preferences", content: { "application/json": { schema: responseSchema } } } },
  }), (c) => {
    const key = memberKey(deps.member(c));
    return respond(c, key, readMemberPreferences(deps.polpoDir(), key)) as never;
  });

  app.openapi(createRoute({
    method: "patch", path: "/", tags: ["Preferences"],
    summary: "Update the signed-in member's dashboard preferences",
    description: "Merges the given fields into the stored preferences (per section, field by field).",
    request: { body: { required: true, content: { "application/json": { schema: patchSchema } } } },
    responses: { 200: { description: "Updated preferences", content: { "application/json": { schema: responseSchema } } } },
  }), (c) => {
    const key = memberKey(deps.member(c));
    const next = updateMemberPreferences(deps.polpoDir(), key, c.req.valid("json"));
    return respond(c, key, next) as never;
  });

  return app;
}
