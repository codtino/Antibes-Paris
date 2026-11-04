// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) avec WebCrypto uniquement,
// pour tourner dans un Worker Cloudflare sans dépendance.

const enc = new TextEncoder();

export function b64uDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// Clé privée VAPID : on reconstruit la JWK à partir de d (privée) et du point public non compressé
async function cleVapid(publicB64, priveB64) {
  const pub = b64uDecode(publicB64);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: priveB64,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function jetonVapid(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const entete = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corps = b64uEncode(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject,
  })));
  const cle = await cleVapid(vapid.publicKey, vapid.privateKey);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cle, enc.encode(`${entete}.${corps}`));
  return `${entete}.${corps}.${b64uEncode(sig)}`;
}

export async function chiffrer(abonnement, texte) {
  const uaPublic = b64uDecode(abonnement.keys.p256dh);
  const authSecret = b64uDecode(abonnement.keys.auth);

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secretEcdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, secretEcdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const cleAes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const clair = concat(enc.encode(texte), new Uint8Array([2]));   // 0x02 = dernier enregistrement
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cleAes, clair));

  const rs = new Uint8Array([0, 0, 16, 0]);                         // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, chiffre);
}

// Envoie une notification. Renvoie le code HTTP du service de push
// (201 = accepté, 404/410 = abonnement expiré à supprimer).
export async function envoyerPush(abonnement, contenu, vapid, { ttl = 6 * 3600, urgence = "normal" } = {}) {
  const corps = await chiffrer(abonnement, JSON.stringify(contenu));
  const jeton = await jetonVapid(abonnement.endpoint, vapid);
  const r = await fetch(abonnement.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgence,
      Authorization: `vapid t=${jeton}, k=${vapid.publicKey}`,
    },
    body: corps,
  });
  return r.status;
}
