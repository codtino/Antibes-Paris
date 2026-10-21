// Service worker : reçoit les notifications envoyées par GitHub Actions
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data.json(); } catch (e) { d = { title: "TGV Max", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "TGV Max", {
    body: d.body || "",
    icon: "icone-192.png",
    badge: "icone-192.png",
    data: { url: d.url || "tableau_de_bord.html" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.registration.scope).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(fenetres => {
    for (const f of fenetres) if (f.url.startsWith(self.registration.scope)) { f.navigate(url); return f.focus(); }
    return clients.openWindow(url);
  }));
});
