/* global self, clients */

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  const title = typeof payload.title === "string" && payload.title
    ? payload.title
    : "Polpo";
  const body = typeof payload.body === "string" ? payload.body : "";
  const severity = payload.severity === "critical" ? "critical" : payload.severity === "warning" ? "warning" : "info";
  const url = safeUrl(payload.data && payload.data.url);

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192-maskable.png",
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    renotify: severity === "critical",
    data: {
      ...(payload.data && typeof payload.data === "object" ? payload.data : {}),
      url,
    },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = safeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && "focus" in client) {
        if ("navigate" in client) await client.navigate(targetUrl);
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const registration = self.registration;
    const oldSubscription = event.oldSubscription;
    const key = await fetch("/api/v1/push/public-key")
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => payload && payload.ok ? payload.data.publicKey : null)
      .catch(() => null);
    if (!key) return;

    const newSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    if (oldSubscription) {
      await fetch("/api/v1/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: oldSubscription.endpoint }),
      }).catch(() => undefined);
    }

    await fetch("/api/v1/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSubscription.toJSON()),
    }).catch(() => undefined);
  })());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { title: "Polpo", body: event.data.text() };
  }
}

function safeUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
