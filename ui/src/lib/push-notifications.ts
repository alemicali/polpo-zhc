import { config } from "@/lib/config";

export type PushPermissionState = NotificationPermission | "unsupported";

export interface PushSubscriptionState {
  supported: boolean;
  permission: PushPermissionState;
  subscribed: boolean;
  subscriptionCount: number;
}

export function getPushSupportState(): PushSubscriptionState {
  const supported = typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window
    && window.isSecureContext;

  return {
    supported,
    permission: supported ? Notification.permission : "unsupported",
    subscribed: false,
    subscriptionCount: 0,
  };
}

export async function getCurrentPushState(): Promise<PushSubscriptionState> {
  const state = getPushSupportState();
  if (!state.supported) return state;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  const status = await pushApi<{ subscriptions: number }>("/push/status");

  return {
    ...state,
    permission: Notification.permission,
    subscribed: !!subscription,
    subscriptionCount: status.ok ? status.data.subscriptions : 0,
  };
}

export async function enablePushNotifications(): Promise<PushSubscriptionState> {
  const state = getPushSupportState();
  if (!state.supported) {
    throw new Error("Push notifications are not available in this browser/context");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Notifications are blocked in browser settings"
      : "Notification permission was not granted");
  }

  const key = await pushApi<{ publicKey: string }>("/push/public-key");
  if (!key.ok) throw new Error(key.error ?? "Could not load push public key");

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const applicationServerKey = urlBase64ToUint8Array(key.data.publicKey);
  const subscription = await getCurrentOrCreateSubscription(registration, existing, applicationServerKey);

  const saved = await pushApi<{ subscriptions: number }>("/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!saved.ok) throw new Error(saved.error ?? "Could not save push subscription");

  return {
    supported: true,
    permission: Notification.permission,
    subscribed: true,
    subscriptionCount: saved.data.subscriptions,
  };
}

export async function disablePushNotifications(): Promise<PushSubscriptionState> {
  const state = getPushSupportState();
  if (!state.supported) return state;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await pushApi("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }

  return getCurrentPushState();
}

async function pushApi<T = unknown>(path: string, init?: RequestInit): Promise<
  | { ok: true; data: T }
  | { ok: false; error?: string }
> {
  try {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    if (init?.body) headers["Content-Type"] = "application/json";
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(`${config.baseUrl}/api/v1${path}`, { ...init, headers });
    return await response.json();
  } catch {
    return { ok: false, error: "Could not connect to server" };
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getCurrentOrCreateSubscription(
  registration: ServiceWorkerRegistration,
  existing: PushSubscription | null,
  applicationServerKey: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  if (existing && pushSubscriptionUsesKey(existing, applicationServerKey)) {
    return existing;
  }

  if (existing) {
    await pushApi("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: existing.endpoint }),
    });
    await existing.unsubscribe();
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
}

function pushSubscriptionUsesKey(subscription: PushSubscription, applicationServerKey: Uint8Array<ArrayBuffer>): boolean {
  const currentKey = subscription.options.applicationServerKey;
  if (!currentKey) return false;
  return arrayBufferEquals(currentKey, applicationServerKey);
}

function arrayBufferEquals(left: ArrayBuffer, right: Uint8Array<ArrayBuffer>): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftView = new Uint8Array(left);
  for (let i = 0; i < leftView.length; i += 1) {
    if (leftView[i] !== right[i]) return false;
  }
  return true;
}
