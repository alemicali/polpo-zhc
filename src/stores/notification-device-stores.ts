/**
 * Web Push subscriptions and Expo tokens of a project: the database tables when the project runs
 * on one, .polpo/push.json and .polpo/expo-tokens.json otherwise. Both implementations share the
 * same methods (the file ones answer synchronously), so callers always `await`.
 */

import { databaseStoresFor } from "../core/storage.js";
import { FileExpoTokenStore, type ExpoTokenRecord } from "./file-expo-token-store.js";
import { FilePushSubscriptionStore, type PushSubscriptionRecord, type PushVapidConfig } from "./file-push-subscription-store.js";

type Awaitable<T> = T | Promise<T>;

export interface PushSubscriptionStoreLike {
  ensureVapid(subject?: string): Awaitable<PushVapidConfig>;
  getVapid(): Awaitable<PushVapidConfig | undefined>;
  upsert(subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }, userAgent?: string): Awaitable<PushSubscriptionRecord>;
  remove(endpoint: string): Awaitable<boolean>;
  list(): Awaitable<PushSubscriptionRecord[]>;
  count(): Awaitable<number>;
  markSuccess(endpoint: string): Awaitable<void>;
  markFailure(endpoint: string): Awaitable<void>;
}

export interface ExpoTokenStoreLike {
  saveToken(input: { token: string; platform: "ios" | "android"; deviceId: string }): Awaitable<ExpoTokenRecord>;
  removeToken(token: string): Awaitable<boolean>;
  removeByDevice(deviceId: string): Awaitable<number>;
  listAll(): Awaitable<ExpoTokenRecord[]>;
  listActive(): Awaitable<ExpoTokenRecord[]>;
  count(): Awaitable<number>;
  countActive(): Awaitable<number>;
  markFailed(token: string): Awaitable<void>;
  markSuccess(token: string): Awaitable<void>;
}

export function pushSubscriptionStoreFor(polpoDir: string): PushSubscriptionStoreLike {
  return databaseStoresFor(polpoDir)?.pushSubscriptionStore ?? new FilePushSubscriptionStore(polpoDir);
}

export function expoTokenStoreFor(polpoDir: string): ExpoTokenStoreLike {
  return databaseStoresFor(polpoDir)?.expoTokenStore ?? new FileExpoTokenStore(polpoDir);
}
