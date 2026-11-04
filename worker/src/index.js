// Serveur TGV Max : API du site + surveillance des publications SNCF + notifications.
import { envoyerPush } from "./webpush.js";

const SNCF = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax";

// ---------------------------------------------------------------- utilitaires

function heureParis(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

const minutes = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const ajouterJours = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ecartJours = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
const jourSemaine = iso => (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7;   // 0 = lundi
const JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const fmtJour = iso => `${JOURS[jourSemaine(iso)]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

async function lireJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "tgvmax-alertes (perso)" } });
  if (!r.ok) throw new Error(`SNCF ${r.status}`);
  return r.json();
}

async function publicationSncf() {
  const m = await lireJson(SNCF);
  return m.metas.default.data_processed;
}

// Tous les trains d'un trajet (avec ou sans place) à partir d'aujourd'hui
async function trainsSncf(o, d, aujourdhui) {
  const p = new URLSearchParams({
    where: `origine_iata="${o}" and destination_iata="${d}" and date>="${aujourdhui}"`,
    select: "date,train_no,heure_depart,heure_arrivee,od_happy_card",
  });
  const rows = await lireJson(`${SNCF}/exports/json?${p}`);
  const uniques = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.train_no}`;
    const libre = r.od_happy_card === "OUI" ? 1 : 0;
    const avant = uniques.get(k);
    if (!avant || libre > avant.libre) {
      uniques.set(k, { date: r.date, train: r.train_no, dep: r.heure_depart, arr: r.heure_arrivee, libre, o, d });
    }
  }
  return [...uniques.values()].sort((a, b) => (a.date + a.dep).localeCompare(b.date + b.dep));
}

async function meta(env, k, v) {
  if (v === undefined) return (await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first())?.v ?? null;
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
}

// ---------------------------------------------------------------- notifications

function vapid(env) {
  return { publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE, subject: env.VAPID_SUBJECT };
}

async function notifierTous(env, contenu, options = {}, seulement = null) {
  const { results } = seulement
    ? await env.DB.prepare("SELECT * FROM devices WHERE endpoint = ?").bind(seulement).all()
    : await env.DB.prepare("SELECT * FROM devices").all();
  const bilan = [];
  for (const dev of results) {
    let statut;
    try {
      statut = await envoyerPush({ endpoint: dev.endpoint, keys: { p256dh: dev.p256dh, auth: dev.auth } },
        { ...contenu, url: contenu.url || env.SITE }, vapid(env), options);
    } catch (e) {
      statut = 0;
    }
    if (statut === 404 || statut === 410) {
      await env.DB.prepare("DELETE FROM devices WHERE endpoint = ?").bind(dev.endpoint).run();
    } else if (statut >= 200 && statut < 300) {
      await env.DB.prepare("UPDATE devices SET last_ok = ? WHERE endpoint = ?").bind(new Date().toISOString(), dev.endpoint).run();
    }
    bilan.push({ label: dev.label, statut });
  }
  return bilan;
}

// ---------------------------------------------------------------- surveillance

function lienJour(env, w, date) {
  return `${env.SITE}#jour=${date}&o=${w.o}&d=${w.d}`;
}

// Calcule ce qui est disponible pour une alerte (trains + allers-retours)
function evaluer(w, cibles, trains) {
  const ok = t => cibles.has(t.date) || (
    w.days.includes(String(jourSemaine(t.date)))
    && t.dep >= w.h_min && t.dep <= w.h_max
    && (!w.date_from || t.date >= w.date_from)
    && (!w.date_to || t.date <= w.date_to));
  const aller = trains.filter(t => t.libre && t.o === w.o && t.d === w.d && ok(t));
  const retour = w.mode === "ar" ? trains.filter(t => t.libre && t.o === w.d && t.d === w.o && ok(t)) : [];
  const combos = [];
  for (const a of aller) for (const r of retour) {
    const e = ecartJours(a.date, r.date);
    if (e < w.stay_min || e > w.stay_max) continue;
    if (e === 0 && minutes(r.dep) < minutes(a.arr) + 60) continue;
    combos.push([a, r]);
  }
  const cles = new Map();
  for (const t of [...aller, ...retour]) cles.set(`T|${t.date}|${t.train}|${t.o}`, t);
  for (const [a, r] of combos) cles.set(`AR|${a.date}|${a.train}|${r.date}|${r.train}`, [a, r]);
  return cles;
}

function ligneTrain(t) { return `${fmtJour(t.date)}  ${t.dep} → ${t.arr}  (train ${t.train})`; }

async function verifierAlerte(env, w, trains, silencieux) {
  const { results: tg } = await env.DB.prepare("SELECT date FROM targets WHERE watch_id = ?").bind(w.id).all();
  const cibles = new Set(tg.map(x => x.date));
  const cles = evaluer(w, cibles, trains);
  const { results: vus } = await env.DB.prepare("SELECT k FROM seen WHERE watch_id = ?").bind(w.id).all();
  const dejaVus = new Set(vus.map(x => x.k));
  const nouveaux = [...cles].filter(([k]) => !dejaVus.has(k));

  if (!silencieux && nouveaux.length) {
    const trainsNouveaux = nouveaux.filter(([k]) => k.startsWith("T|")).map(([, t]) => t);
    const combosNouveaux = nouveaux.filter(([k]) => k.startsWith("AR|")).map(([, c]) => c);

    // 1. Dates ciblées : alerte prioritaire, à part
    const surCible = trainsNouveaux.filter(t => cibles.has(t.date));
    for (const date of new Set(surCible.map(t => t.date))) {
      const liste = surCible.filter(t => t.date === date);
      const nom = t => (t.o === w.o ? `${w.o_name} → ${w.d_name}` : `${w.d_name} → ${w.o_name}`);
      await notifierTous(env, {
        title: `Date ciblée · ${fmtJour(date)} · place disponible`,
        body: liste.map(t => `${nom(t)}  ${t.dep} → ${t.arr}`).join("\n"),
        url: lienJour(env, w, date), tag: `cible-${w.id}-${date}`,
      }, { urgence: "high" });
    }
    // 2. Allers-retours
    if (combosNouveaux.length) {
      await notifierTous(env, {
        title: `Aller-retour possible · ${w.o_name} ⇄ ${w.d_name}`,
        body: combosNouveaux.slice(0, 6).map(([a, r]) => `Aller ${fmtJour(a.date)} ${a.dep} · Retour ${fmtJour(r.date)} ${r.dep}`).join("\n")
          + (combosNouveaux.length > 6 ? `\n+ ${combosNouveaux.length - 6} autres` : ""),
        url: lienJour(env, w, combosNouveaux[0][0].date),
      }, { urgence: "high" });
    }
    // 3. Places par sens (hors dates ciblées, déjà signalées)
    const sens = [[w.o, w.d, w.o_name, w.d_name], [w.d, w.o, w.d_name, w.o_name]];
    for (const [o, d, on, dn] of sens) {
      const liste = trainsNouveaux.filter(t => t.o === o && t.d === d && !cibles.has(t.date));
      if (!liste.length) continue;
      await notifierTous(env, {
        title: `${on} → ${dn} · ${liste.length} nouvelle${liste.length > 1 ? "s" : ""} place${liste.length > 1 ? "s" : ""}`,
        body: liste.slice(0, 8).map(ligneTrain).join("\n") + (liste.length > 8 ? `\n+ ${liste.length - 8} autres` : ""),
        url: lienJour(env, { ...w, o, d }, liste[0].date),
      });
    }
  }

  // On mémorise l'état actuel : une place qui disparaît puis revient sera de nouveau signalée
  const ops = [env.DB.prepare("DELETE FROM seen WHERE watch_id = ?").bind(w.id)];
  for (const k of cles.keys()) ops.push(env.DB.prepare("INSERT OR IGNORE INTO seen (watch_id, k) VALUES (?, ?)").bind(w.id, k));
  await env.DB.batch(ops);
  return nouveaux.length;
}

async function trajetsDesAlertes(watches) {
  const ods = new Set();
  for (const w of watches) {
    ods.add(`${w.o}>${w.d}`);
    if (w.mode === "ar") ods.add(`${w.d}>${w.o}`);
  }
  return [...ods];
}

async function verifier(env, snap, { silencieux = false, seulement = null } = {}) {
  const aujourdhui = heureParis().date;
  const { results: toutes } = await env.DB.prepare("SELECT * FROM watches WHERE active = 1").all();
  const watches = seulement ? toutes.filter(w => w.id === seulement) : toutes;
  const trains = [];
  for (const od of await trajetsDesAlertes(watches)) {
    const [o, d] = od.split(">");
    const liste = await trainsSncf(o, d, aujourdhui);
    trains.push(...liste);
    if (snap) {
      const ops = liste.map(t => env.DB.prepare(
        "INSERT OR REPLACE INTO obs (snap, od, date, train, dep, arr, libre) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(snap, od, t.date, t.train, t.dep, t.arr, t.libre));
      for (let i = 0; i < ops.length; i += 90) await env.DB.batch(ops.slice(i, i + 90));
    }
  }
  let nouveaux = 0;
  for (const w of watches) nouveaux += await verifierAlerte(env, w, trains, silencieux);
  return nouveaux;
}

// Rappels de confirmation TGV Max : entre J-2 et la veille 17 h
async function rappels(env) {
  const { date, hm } = heureParis();
  await env.DB.prepare("DELETE FROM trips WHERE date < ?").bind(date).run();
  if (hm >= "09:00") {
    const { results } = await env.DB.prepare("SELECT * FROM trips WHERE r1 = 0 AND date = ?").bind(ajouterJours(date, 2)).all();
    for (const t of results) {
      await notifierTous(env, {
        title: `Confirme ton voyage du ${fmtJour(t.date)}`,
        body: `${t.o_name} → ${t.d_name}  ${t.dep}${t.train ? ` (train ${t.train})` : ""}\nConfirmation ouverte, à faire avant demain 17 h dans ton espace MAX.`,
        tag: `trip-${t.id}`,
      }, { urgence: "high" });
      await env.DB.prepare("UPDATE trips SET r1 = 1 WHERE id = ?").bind(t.id).run();
    }
  }
  if (hm >= "12:00") {
    const { results } = await env.DB.prepare("SELECT * FROM trips WHERE r2 = 0 AND date = ?").bind(ajouterJours(date, 1)).all();
    for (const t of results) {
      await notifierTous(env, {
        title: `Dernier délai 17 h : confirme ton voyage de demain`,
        body: `${t.o_name} → ${t.d_name}  ${t.dep}${t.train ? ` (train ${t.train})` : ""}\nSans confirmation, la réservation est annulée.`,
        tag: `trip-${t.id}`,
      }, { urgence: "high" });
      await env.DB.prepare("UPDATE trips SET r2 = 1 WHERE id = ?").bind(t.id).run();
    }
  }
}

// La SNCF publie vers 6 h 23 et parfois vers 12 h (heure de Paris)
function fenetrePublication(hm) {
  return (hm >= "06:00" && hm <= "07:45") || (hm >= "11:30" && hm <= "13:15");
}

async function tache(env, maintenant) {
  await rappels(env);
  const { hm } = heureParis(maintenant);
  const cibles = await env.DB.prepare("SELECT COUNT(*) AS n FROM targets").first();
  const chaqueMinute = fenetrePublication(hm) || cibles.n > 0;
  if (!chaqueMinute && maintenant.getUTCMinutes() % 10 !== 0) return;

  await meta(env, "dernier_controle", maintenant.toISOString());
  const snap = await publicationSncf();
  if (snap === await meta(env, "snap")) return;
  const n = await verifier(env, snap);
  await meta(env, "snap", snap);
  await meta(env, "snap_vu", maintenant.toISOString());
  console.log(`Nouvelle publication SNCF ${snap} : ${n} nouveauté(s)`);
}

// ---------------------------------------------------------------- API

function entetesCors(env, req) {
  const origine = req.headers.get("Origin");
  const ok = env.ORIGINES.split(",").includes(origine);
  return {
    "Access-Control-Allow-Origin": ok ? origine : env.ORIGINES.split(",")[0],
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status = 200, cors = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

const champsAlerte = ["o", "o_name", "d", "d_name", "mode", "days", "h_min", "h_max", "date_from", "date_to", "stay_min", "stay_max", "active"];

function validerAlerte(b) {
  const code = /^FR[A-Z]{3}$/, heure = /^([01]\d|2[0-3]):[0-5]\d$/, date = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  for (const n of ["stay_min", "stay_max"]) {
    if (b[n] !== undefined && !(Number.isInteger(Number(b[n])) && Number(b[n]) >= 0 && Number(b[n]) <= 30)) return "durée de séjour invalide";
  }
  if (b.o !== undefined && !code.test(b.o)) return "gare de départ invalide";
  if (b.d !== undefined && !code.test(b.d)) return "gare d'arrivée invalide";
  if (b.mode !== undefined && !["aller", "ar"].includes(b.mode)) return "mode invalide";
  if (b.days !== undefined && !/^[0-6]{0,7}$/.test(b.days)) return "jours invalides";
  for (const h of ["h_min", "h_max"]) if (b[h] !== undefined && !heure.test(b[h])) return "heure invalide";
  for (const d of ["date_from", "date_to"]) if (b[d] && !date.test(b[d])) return "date invalide";
  return null;
}

async function api(req, env, ctx) {
  const url = new URL(req.url);
  const cors = entetesCors(env, req);
  const rep = (data, status = 200) => json(data, status, cors);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const chemin = url.pathname.replace(/\/+$/, "");
  const corps = ["POST", "PATCH", "DELETE"].includes(req.method) ? await req.json().catch(() => ({})) : {};

  // --- public
  if (chemin === "/api/config") {
    return rep({
      vapid: env.VAPID_PUBLIC,
      snap: await meta(env, "snap"),
      snap_vu: await meta(env, "snap_vu"),
      dernier_controle: await meta(env, "dernier_controle"),
    });
  }
  if (chemin === "/api/stats") {
    const od = url.searchParams.get("od") || "";
    const { results: snaps } = await env.DB.prepare("SELECT DISTINCT snap FROM obs WHERE od = ? ORDER BY snap").bind(od).all();
    const index = new Map(snaps.map((s, i) => [s.snap, i]));
    const { results: jours } = await env.DB.prepare(
      "SELECT date, snap, MAX(libre) AS l FROM obs WHERE od = ? GROUP BY date, snap").bind(od).all();
    const { results: trains } = await env.DB.prepare(
      "SELECT dep, SUM(libre) AS l, COUNT(*) AS n FROM obs WHERE od = ? GROUP BY dep ORDER BY dep").bind(od).all();
    return rep({
      snaps: snaps.map(s => s.snap),
      jours: jours.map(j => [j.date, index.get(j.snap), j.l]),
      trains: trains.map(t => [t.dep, t.l, t.n]),
    });
  }
  if (chemin === "/api/changes") {
    // Places apparues lors de la dernière publication SNCF (trajets surveillés uniquement)
    const od = url.searchParams.get("od") || "";
    const { results: deux } = await env.DB.prepare(
      "SELECT DISTINCT snap FROM obs WHERE od = ? ORDER BY snap DESC LIMIT 2").bind(od).all();
    if (deux.length < 2) return rep({ snap: deux[0]?.snap ?? null, nouveaux: [] });
    const { results } = await env.DB.prepare(
      `SELECT a.date, a.train FROM obs a LEFT JOIN obs b
         ON b.od = a.od AND b.snap = ? AND b.date = a.date AND b.train = a.train
       WHERE a.od = ? AND a.snap = ? AND a.libre = 1 AND (b.libre IS NULL OR b.libre = 0)`)
      .bind(deux[1].snap, od, deux[0].snap).all();
    return rep({ snap: deux[0].snap, nouveaux: results.map(r => `${r.date}|${r.train}`) });
  }

  // --- protégé par le code d'accès
  if (!env.ACCESS_CODE || req.headers.get("X-Code") !== env.ACCESS_CODE) return rep({ erreur: "code d'accès incorrect" }, 401);

  if (chemin === "/api/auth") return rep({ ok: true });

  if (chemin === "/api/devices") {
    if (req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT endpoint, label, created, last_ok FROM devices ORDER BY created").all();
      return rep(results.map(d => ({ ...d, service: new URL(d.endpoint).host })));
    }
    if (req.method === "POST") {
      const s = corps.subscription;
      if (!s?.endpoint?.startsWith("https://") || !s.keys?.p256dh || !s.keys?.auth) return rep({ erreur: "abonnement invalide" }, 400);
      await env.DB.prepare(
        `INSERT INTO devices (endpoint, p256dh, auth, label, created) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`)
        .bind(s.endpoint, s.keys.p256dh, s.keys.auth, String(corps.label || "Appareil").slice(0, 60), new Date().toISOString()).run();
      return rep({ ok: true });
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM devices WHERE endpoint = ?").bind(corps.endpoint || "").run();
      return rep({ ok: true });
    }
  }

  if (chemin === "/api/test" && req.method === "POST") {
    const bilan = await notifierTous(env, {
      title: "Notifications actives",
      body: "Cet appareil recevra les alertes TGV Max.",
    }, { urgence: "high", ttl: 600 }, corps.endpoint || null);
    return rep({ bilan });
  }

  if (chemin === "/api/run" && req.method === "POST") {
    const snap = await publicationSncf();
    const avant = await meta(env, "snap");
    await meta(env, "dernier_controle", new Date().toISOString());
    if (snap === avant) return rep({ snap, nouvelle: false, nouveautes: 0 });
    const n = await verifier(env, snap);
    await meta(env, "snap", snap);
    await meta(env, "snap_vu", new Date().toISOString());
    return rep({ snap, nouvelle: true, nouveautes: n });
  }

  if (chemin === "/api/watches") {
    if (req.method === "GET") {
      const { results: ws } = await env.DB.prepare("SELECT * FROM watches ORDER BY id").all();
      const { results: tg } = await env.DB.prepare("SELECT * FROM targets ORDER BY date").all();
      return rep(ws.map(w => ({ ...w, targets: tg.filter(t => t.watch_id === w.id).map(t => t.date) })));
    }
    if (req.method === "POST") {
      const erreur = validerAlerte(corps) || (!corps.o || !corps.d ? "trajet manquant" : null);
      if (erreur) return rep({ erreur }, 400);
      const v = { mode: "ar", days: "0123456", h_min: "00:00", h_max: "23:59", stay_min: 1, stay_max: 7, active: 1, ...corps };
      const r = await env.DB.prepare(
        `INSERT INTO watches (o, o_name, d, d_name, mode, days, h_min, h_max, date_from, date_to, stay_min, stay_max, active, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(v.o, v.o_name || v.o, v.d, v.d_name || v.d, v.mode, v.days, v.h_min, v.h_max, v.date_from || null, v.date_to || null,
          Number(v.stay_min), Number(v.stay_max), v.active ? 1 : 0, new Date().toISOString()).run();
      const id = r.meta.last_row_id;
      // L'état actuel est mémorisé sans notifier : seules les nouveautés seront signalées
      ctx.waitUntil(verifier(env, null, { silencieux: true, seulement: id }));
      return rep({ id });
    }
  }

  const mw = chemin.match(/^\/api\/watches\/(\d+)$/);
  if (mw) {
    const id = Number(mw[1]);
    if (req.method === "PATCH") {
      const erreur = validerAlerte(corps);
      if (erreur) return rep({ erreur }, 400);
      const champs = champsAlerte.filter(c => corps[c] !== undefined);
      if (champs.length) {
        await env.DB.prepare(`UPDATE watches SET ${champs.map(c => `${c} = ?`).join(", ")} WHERE id = ?`)
          .bind(...champs.map(c => (c === "active" ? (corps[c] ? 1 : 0) : corps[c] === "" ? null : corps[c])), id).run();
        ctx.waitUntil(verifier(env, null, { silencieux: true, seulement: id }));
      }
      return rep({ ok: true });
    }
    if (req.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM watches WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM seen WHERE watch_id = ?").bind(id),
        env.DB.prepare("DELETE FROM targets WHERE watch_id = ?").bind(id),
      ]);
      return rep({ ok: true });
    }
  }

  if (chemin === "/api/targets") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(corps.date || "")) return rep({ erreur: "date invalide" }, 400);
    if (req.method === "POST") {
      await env.DB.prepare("INSERT OR IGNORE INTO targets (watch_id, date) VALUES (?, ?)").bind(Number(corps.watch_id), corps.date).run();
      return rep({ ok: true });
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM targets WHERE watch_id = ? AND date = ?").bind(Number(corps.watch_id), corps.date).run();
      return rep({ ok: true });
    }
  }

  if (chemin === "/api/trips") {
    if (req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM trips ORDER BY date, dep").all();
      return rep(results);
    }
    if (req.method === "POST") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(corps.date || "") || !/^\d{2}:\d{2}$/.test(corps.dep || "")) return rep({ erreur: "train invalide" }, 400);
      const r = await env.DB.prepare("INSERT INTO trips (date, dep, arr, train, o_name, d_name) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(corps.date, corps.dep, corps.arr || null, corps.train || null, corps.o_name || "", corps.d_name || "").run();
      return rep({ id: r.meta.last_row_id });
    }
  }
  const mt = chemin.match(/^\/api\/trips\/(\d+)$/);
  if (mt && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(Number(mt[1])).run();
    return rep({ ok: true });
  }

  return rep({ erreur: "introuvable" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await api(req, env, ctx);
    } catch (e) {
      return json({ erreur: String(e.message || e) }, 500, entetesCors(env, req));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tache(env, new Date(event.scheduledTime)));
  },
};
