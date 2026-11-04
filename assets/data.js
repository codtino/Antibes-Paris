// Accès aux données : open data SNCF (TGV Max), jours fériés, vacances scolaires, serveur d'alertes.

export const API_SERVEUR = "https://tgvmax.tgvmax-worker.workers.dev";
const SNCF = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax";

// ------------------------------------------------------------ dates

export const JOURS_COURTS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
export const JOURS_LONGS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
export const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function isoLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const versDate = iso => { const [y, m, j] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, j); };
export const jourSemaine = iso => (versDate(iso).getDay() + 6) % 7;
export const ajouterJours = (iso, n) => { const d = versDate(iso); d.setDate(d.getDate() + n); return isoLocal(d); };
export const ecartJours = (a, b) => Math.round((versDate(b) - versDate(a)) / 864e5);
export const fmtCourt = iso => `${JOURS_COURTS[jourSemaine(iso)]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const fmtLong = iso => `${JOURS_LONGS[jourSemaine(iso)]} ${Number(iso.slice(8, 10))} ${MOIS[Number(iso.slice(5, 7)) - 1]}`;
export const minutes = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
export function duree(dep, arr) {
  let m = minutes(arr) - minutes(dep);
  if (m < 0) m += 1440;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------ cache local (facultatif)

function lireCache(cle, dureeMs) {
  try {
    const v = JSON.parse(localStorage.getItem(cle));
    if (v && Date.now() - v.t < dureeMs) return v.d;
  } catch { /* stockage indisponible */ }
  return null;
}
function ecrireCache(cle, d) {
  try { localStorage.setItem(cle, JSON.stringify({ t: Date.now(), d })); } catch { /* ignoré */ }
}

async function lireJson(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`Erreur ${r.status} sur ${new URL(url).host}`);
  return r.json();
}

// ------------------------------------------------------------ gares

const PETITS = new Set(["de", "du", "des", "la", "le", "les", "sur", "en", "et", "l", "d"]);
export function nomGare(brut) {
  if (/^PARIS \(intramuros\)$/i.test(brut)) return "Paris (toutes gares)";
  return brut.toLowerCase().split(/([\s\-'()]+)/).map((mot, i) => {
    if (i > 0 && PETITS.has(mot)) return mot;
    if (["tgv", "cdg"].includes(mot)) return mot.toUpperCase();
    return mot.charAt(0).toUpperCase() + mot.slice(1);
  }).join("");
}

export async function gares() {
  const cache = lireCache("gares", 7 * 864e5);
  if (cache) return cache;
  const p = new URLSearchParams({ select: "origine,origine_iata", group_by: "origine,origine_iata", limit: "-1" });
  const r = await lireJson(`${SNCF}/records?${p}`);
  const liste = r.results.map(g => ({ code: g.origine_iata, nom: nomGare(g.origine), brut: g.origine }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  ecrireCache("gares", liste);
  return liste;
}

// ------------------------------------------------------------ trains TGV Max disponibles

function versTrain(r) {
  return {
    date: r.date, train: r.train_no, o: r.origine_iata, d: r.destination_iata,
    oNom: nomGare(r.origine), dNom: nomGare(r.destination), dep: r.heure_depart, arr: r.heure_arrivee,
  };
}

function dedoublonner(rows) {
  const vus = new Map();
  for (const r of rows) vus.set(`${r.date}|${r.train_no}|${r.origine_iata}|${r.destination_iata}`, r);
  return [...vus.values()].map(versTrain).sort((a, b) => (a.date + a.dep).localeCompare(b.date + b.dep));
}

async function exporter(where) {
  const p = new URLSearchParams({
    where: `${where} and od_happy_card="OUI" and date>="${isoLocal()}"`,
    select: "date,train_no,origine,origine_iata,destination,destination_iata,heure_depart,heure_arrivee",
  });
  return dedoublonner(await lireJson(`${SNCF}/exports/json?${p}`));
}

// Places disponibles sur un trajet (et le retour si demandé)
export function placesTrajet(o, d, avecRetour) {
  const w = avecRetour
    ? `((origine_iata="${o}" and destination_iata="${d}") or (origine_iata="${d}" and destination_iata="${o}"))`
    : `origine_iata="${o}" and destination_iata="${d}"`;
  return exporter(w);
}

// Toutes les places au départ d'une gare entre deux dates
export function placesDepuis(o, du, au) {
  return exporter(`origine_iata="${o}" and date>="${du}" and date<="${au}"`);
}

// Toutes les places à l'arrivée d'une gare entre deux dates
export function placesVers(d, du, au) {
  return exporter(`destination_iata="${d}" and date>="${du}" and date<="${au}"`);
}

export async function publicationSncf() {
  const m = await lireJson(SNCF);
  return m.metas.default.data_processed;
}

// Prochaine publication SNCF : vers 6 h 23 chaque jour, parfois vers 12 h
export function prochainePublication(maintenant = new Date()) {
  const hm = maintenant.getHours() * 60 + maintenant.getMinutes();
  if (hm < 6 * 60 + 23) return "aujourd'hui vers 6 h 25";
  if (hm < 12 * 60 + 5) return "parfois vers 12 h, sinon demain 6 h 25";
  return "demain vers 6 h 25";
}

// ------------------------------------------------------------ allers-retours et correspondances

export function allersRetours(trains, o, d, sejourMin, sejourMax) {
  const aller = trains.filter(t => t.o === o && t.d === d);
  const retour = trains.filter(t => t.o === d && t.d === o);
  const res = [];
  for (const a of aller) for (const r of retour) {
    const e = ecartJours(a.date, r.date);
    if (e < sejourMin || e > sejourMax) continue;
    if (e === 0 && minutes(r.dep) < minutes(a.arr) + 60) continue;
    res.push({ aller: a, retour: r, nuits: e });
  }
  return res;
}

// Deux trains à 0 € le même jour via une gare intermédiaire.
// Cas particulier précieux : le même train sur deux billets (o → X puis X → d), quand le direct est complet.
export function correspondances(depuisO, versD, o, d, changementMin) {
  const directs = depuisO.filter(t => t.d === d);
  const res = [];
  for (const a of depuisO) {
    if (a.d === d || a.o !== o) continue;
    for (const b of versD) {
      if (b.o !== a.d || b.date !== a.date || b.d !== d) continue;
      if (minutes(a.arr) < minutes(a.dep)) continue;                       // arrivée après minuit
      const attente = minutes(b.dep) - minutes(a.arr);
      const memeTrain = a.train === b.train;
      const min = memeTrain ? 0 : a.d === "FRPLY" ? Math.max(changementMin, 75) : changementMin;  // changement de gare à Paris
      if (attente < min || attente > 6 * 60) continue;
      const total = minutes(b.arr) - minutes(a.dep);
      // Inutile si un direct gratuit part au moins aussi tard et arrive au moins aussi tôt
      if (directs.some(t => minutes(t.dep) >= minutes(a.dep) && minutes(t.arr) <= minutes(b.arr))) continue;
      res.push({ a, b, attente, total, memeTrain });
    }
  }
  return res.sort((x, y) => (y.memeTrain - x.memeTrain) || minutes(x.b.arr) - minutes(y.b.arr) || x.total - y.total);
}

// ------------------------------------------------------------ jours fériés, ponts, vacances

export async function calendrierFrance() {
  const cache = lireCache("calendrier-fr", 7 * 864e5);
  if (cache) return cache;
  const feries = await lireJson("https://calendrier.api.gouv.fr/jours-feries/metropole.json");
  const depuis = ajouterJours(isoLocal(), -400);
  const p = new URLSearchParams({
    where: `end_date>="${depuis}" and population!="Enseignants" and zones in ("Zone A", "Zone B", "Zone C")`,
    select: "description,zones,start_date,end_date",
    group_by: "description,zones,start_date,end_date",
    limit: "-1",
  });
  const r = await lireJson(`https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records?${p}`);
  // Dates en UTC (22 h ou 23 h la veille) : +2 h donne le jour local
  const local = s => isoLocal(new Date(new Date(s).getTime() + 2 * 3600e3));
  const vacances = r.results
    .filter(v => /^Zone [ABC]$/.test(v.zones))
    .map(v => ({ nom: v.description, zone: v.zones.slice(-1), debut: local(v.start_date), fin: local(v.end_date) }));
  const res = { feries, vacances };
  ecrireCache("calendrier-fr", res);
  return res;
}

// Pour chaque jour : jour férié, pont, zones en vacances, départs / retours de vacances
export function typesDeJours({ feries, vacances }, debut, fin) {
  const vac = {}, departs = new Set(), retours = new Set(), pontsScolaires = new Set();
  for (const v of vacances) {
    const nbJours = ecartJours(v.debut, v.fin);
    if (/pont/i.test(v.nom)) {
      for (let i = 0; i < nbJours; i++) pontsScolaires.add(ajouterJours(v.debut, i));
      continue;
    }
    if (nbJours <= 1) continue;
    for (let i = 0; i < nbJours; i++) ((vac[ajouterJours(v.debut, i)] ||= {})[v.zone] = v.nom);
    [-1, 0, 1].forEach(k => departs.add(ajouterJours(v.debut, k)));
    [-2, -1].forEach(k => retours.add(ajouterJours(v.fin, k)));
  }
  const ferie = iso => iso in feries;
  const pont = iso => {
    const j = jourSemaine(iso);
    return (j < 5 && pontsScolaires.has(iso) && !ferie(iso))
      || (j === 0 && ferie(ajouterJours(iso, 1))) || (j === 4 && ferie(ajouterJours(iso, -1)));
  };
  const repos = iso => jourSemaine(iso) >= 5 || ferie(iso) || pont(iso);
  const bloc = iso => {
    let g = iso, d = iso;
    while (repos(ajouterJours(g, -1))) g = ajouterJours(g, -1);
    while (repos(ajouterJours(d, 1))) d = ajouterJours(d, 1);
    return ecartJours(g, d) + 1;
  };
  const jours = {};
  for (let iso = debut; iso <= fin; iso = ajouterJours(iso, 1)) {
    const tags = [], libelles = [];
    if (ferie(iso)) { tags.push("ferie"); libelles.push(feries[iso]); }
    if (pont(iso)) libelles.push("Pont");
    if (repos(iso) && bloc(iso) >= 3) tags.push("pont");
    const zones = Object.keys(vac[iso] || {}).sort();
    if (zones.length) {
      zones.forEach(z => tags.push("vac" + z));
      libelles.push(`${[...new Set(Object.values(vac[iso]))].join(" / ")} (zone ${zones.join(", ")})`);
    }
    if (departs.has(iso)) { tags.push("depart"); libelles.push("Départ en vacances"); }
    if (retours.has(iso)) { tags.push("retour"); libelles.push("Retour de vacances"); }
    if (!tags.length) tags.push("normal");
    jours[iso] = { tags, libelles, zones, ferie: ferie(iso) ? feries[iso] : null, pont: pont(iso) };
  }
  return jours;
}

export const CATEGORIES = {
  normal: "Jour normal", vacA: "Vacances zone A", vacB: "Vacances zone B", vacC: "Vacances zone C",
  depart: "Départ en vacances", retour: "Retour de vacances", ferie: "Jour férié", pont: "Pont / week-end prolongé",
};

// ------------------------------------------------------------ serveur d'alertes

export function codeAcces() {
  try { return localStorage.getItem("code-acces") || ""; } catch { return ""; }
}
export function memoriserCode(c) {
  try { localStorage.setItem("code-acces", c); } catch { /* ignoré */ }
}

export async function serveur(chemin, { methode = "GET", corps } = {}) {
  const r = await fetch(API_SERVEUR + chemin, {
    method: methode,
    headers: { "Content-Type": "application/json", "X-Code": codeAcces() },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.erreur || `Erreur serveur ${r.status}`);
    e.statut = r.status;
    throw e;
  }
  return data;
}
