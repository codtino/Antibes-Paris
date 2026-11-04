import {
  API_SERVEUR, JOURS_COURTS, MOIS, isoLocal, versDate, jourSemaine, ajouterJours, ecartJours, fmtCourt, fmtLong,
  minutes, duree, gares, placesTrajet, placesDepuis, placesVers, publicationSncf, prochainePublication,
  allersRetours, correspondances, calendrierFrance, typesDeJours, CATEGORIES, codeAcces, memoriserCode, serveur,
} from "./data.js?v=7";

// ------------------------------------------------------------ état

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const etat = {
  gares: [], parCode: new Map(),
  o: "FRXAT", d: "FRPLY", ar: true, sejourMin: 1, sejourMax: 7,
  trains: [], combos: [], nouveaux: new Set(), jours: {}, calFr: null,
  stats: {}, alertes: null, jourChoisi: null, vue: "calendrier", chargement: 0,
};

function lireLocal(cle, defaut) { try { return JSON.parse(localStorage.getItem(cle)) ?? defaut; } catch { return defaut; } }
function ecrireLocal(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); } catch { /* ignoré */ } }

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("cache");
  clearTimeout(toast.minuteur);
  toast.minuteur = setTimeout(() => t.classList.add("cache"), ms);
}

const nom = code => etat.parCode.get(code)?.nom || code;
const SNCF_CONNECT = "https://www.sncf-connect.com/";

// ------------------------------------------------------------ URL (#vue=…&o=…&d=…&jour=…)

function lireHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("o")) etat.o = p.get("o");
  if (p.get("d")) etat.d = p.get("d");
  if (p.get("ar")) etat.ar = p.get("ar") === "1";
  if (p.get("vue")) etat.vue = p.get("vue");
  if (p.get("jour")) { etat.jourChoisi = p.get("jour"); etat.vue = "calendrier"; }
}
function ecrireHash() {
  const p = new URLSearchParams({ vue: etat.vue, o: etat.o, d: etat.d, ar: etat.ar ? "1" : "0" });
  if (etat.jourChoisi && etat.vue === "calendrier") p.set("jour", etat.jourChoisi);
  history.replaceState(null, "", "#" + p);
  ecrireLocal("trajet", { o: etat.o, d: etat.d, ar: etat.ar, sejourMin: etat.sejourMin, sejourMax: etat.sejourMax });
}

// ------------------------------------------------------------ autocomplétion des gares

function autocompletion(input, surChoix) {
  const liste = document.createElement("ul");
  liste.className = "auto-liste cache";
  liste.setAttribute("role", "listbox");
  input.parentElement.appendChild(liste);
  let choix = [], index = -1;
  const normaliser = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function afficher() {
    const q = normaliser(input.value.trim());
    choix = !q ? [] : etat.gares
      .map(g => ({ g, n: normaliser(g.nom) }))
      .filter(x => x.n.includes(q))
      .sort((a, b) => (b.n.startsWith(q) - a.n.startsWith(q)) || a.n.localeCompare(b.n))
      .slice(0, 9).map(x => x.g);
    index = choix.length ? 0 : -1;
    liste.innerHTML = choix.map((g, i) =>
      `<li role="option" data-i="${i}" aria-selected="${i === index}">${esc(g.nom)}<small>${g.code}</small></li>`).join("");
    liste.classList.toggle("cache", !choix.length);
  }
  function valider(i) {
    const g = choix[i];
    if (!g) return;
    input.value = g.nom;
    input.dataset.code = g.code;
    liste.classList.add("cache");
    surChoix?.(g);
  }
  input.addEventListener("input", () => { delete input.dataset.code; afficher(); });
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", e => {
    if (liste.classList.contains("cache")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + choix.length) % choix.length;
      liste.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", i === index));
    } else if (e.key === "Enter" && index >= 0) {
      e.preventDefault();
      valider(index);
    } else if (e.key === "Escape") liste.classList.add("cache");
  });
  liste.addEventListener("mousedown", e => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); valider(Number(li.dataset.i)); }
  });
  input.addEventListener("blur", () => setTimeout(() => liste.classList.add("cache"), 120));
}

function codeDe(input) {
  if (input.dataset.code) return input.dataset.code;
  const v = input.value.trim().toLowerCase();
  return etat.gares.find(g => g.nom.toLowerCase() === v || g.code.toLowerCase() === v)?.code || null;
}
function remplirGare(input, code) {
  input.value = nom(code);
  input.dataset.code = code;
}

// ------------------------------------------------------------ barre de trajet et favoris

function afficherMode() {
  $("#mode-aller").setAttribute("aria-pressed", !etat.ar);
  $("#mode-ar").setAttribute("aria-pressed", etat.ar);
  $("#sejour").classList.toggle("cache", !etat.ar);
  $("#bloc-ar").classList.toggle("cache", !etat.ar);
}

function afficherFavoris() {
  const favs = lireLocal("favoris", []);
  const surveilles = (etat.alertes || []).map(w => ({ o: w.o, d: w.d, ar: w.mode === "ar" }));
  const tous = [...surveilles, ...favs].filter((f, i, a) => a.findIndex(x => x.o === f.o && x.d === f.d) === i);
  const actuelFav = favs.some(f => f.o === etat.o && f.d === etat.d);
  $("#favoris").innerHTML = (tous.length ? "Trajets : " : "") + tous.map((f, i) =>
    `<button type="button" data-fav="${i}">${esc(nom(f.o))} ${f.ar ? "⇄" : "→"} ${esc(nom(f.d))}</button>`).join("")
    + `<button type="button" id="fav-basculer">${actuelFav ? "Retirer ce trajet des favoris" : "Ajouter ce trajet aux favoris"}</button>`;
  $("#favoris").querySelectorAll("[data-fav]").forEach(b => b.onclick = () => {
    const f = tous[Number(b.dataset.fav)];
    changerTrajet(f.o, f.d, f.ar);
  });
  $("#fav-basculer").onclick = () => {
    const l = lireLocal("favoris", []).filter(f => !(f.o === etat.o && f.d === etat.d));
    if (!actuelFav) l.push({ o: etat.o, d: etat.d, ar: etat.ar });
    ecrireLocal("favoris", l);
    afficherFavoris();
  };
}

function changerTrajet(o, d, ar = etat.ar) {
  etat.o = o; etat.d = d; etat.ar = ar; etat.jourChoisi = null;
  remplirGare($("#gare-o"), o);
  remplirGare($("#gare-d"), d);
  afficherMode();
  afficherFavoris();
  changerVue("calendrier");
  charger();
}

// ------------------------------------------------------------ chargement des places

async function charger({ force = false } = {}) {
  const jeton = ++etat.chargement;
  $("#calendrier").innerHTML = `<div class="vide"><span class="tourne"></span>Recherche des places à 0 €…</div>`;
  $("#titre-cal").textContent = `${nom(etat.o)} ${etat.ar ? "⇄" : "→"} ${nom(etat.d)}`;
  ecrireHash();
  try {
    const [trains] = await Promise.all([
      placesTrajet(etat.o, etat.d, etat.ar),
      chargerNouveautes(),
      chargerStats(etat.o, etat.d), etat.ar ? chargerStats(etat.d, etat.o) : null,
    ]);
    if (jeton !== etat.chargement) return;
    etat.trains = trains;
    etat.combos = etat.ar ? allersRetours(trains, etat.o, etat.d, etat.sejourMin, etat.sejourMax) : [];
    afficherCalendrier();
    if (etat.jourChoisi) afficherDetail(etat.jourChoisi);
    if (force) toast(`Données actualisées : ${trains.length} place${trains.length > 1 ? "s" : ""} trouvée${trains.length > 1 ? "s" : ""}.`);
  } catch (e) {
    if (jeton !== etat.chargement) return;
    $("#calendrier").innerHTML = `<div class="vide erreur">Impossible de joindre la SNCF (${esc(e.message)}). Réessaie avec « Actualiser ».</div>`;
  }
}

async function chargerNouveautes() {
  etat.nouveaux = new Set();
  const ods = [`${etat.o}>${etat.d}`, ...(etat.ar ? [`${etat.d}>${etat.o}`] : [])];
  await Promise.all(ods.map(async od => {
    try {
      const r = await fetch(`${API_SERVEUR}/api/changes?od=${encodeURIComponent(od)}`).then(x => x.json());
      r.nouveaux.forEach(k => etat.nouveaux.add(`${od}|${k}`));
    } catch { /* serveur indisponible : pas de badge */ }
  }));
}
const estNouveau = t => etat.nouveaux.has(`${t.o}>${t.d}|${t.date}|${t.train}`);

async function chargerStats(o, d) {
  const od = `${o}>${d}`;
  if (etat.stats[od]) return etat.stats[od];
  try {
    etat.stats[od] = await fetch(`${API_SERVEUR}/api/stats?od=${encodeURIComponent(od)}`).then(x => x.json());
  } catch { etat.stats[od] = { snaps: [], jours: [], trains: [] }; }
  return etat.stats[od];
}

// ------------------------------------------------------------ état de la publication SNCF

async function afficherEtat() {
  try {
    const snap = new Date(await publicationSncf());
    const j = isoLocal(snap) === isoLocal() ? "aujourd'hui" : fmtCourt(isoLocal(snap));
    $("#etat-publication").innerHTML =
      `<span class="signal"></span>Publication SNCF : <b>${j} ${snap.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</b> · prochaine ${prochainePublication()}`;
  } catch {
    $("#etat-publication").innerHTML = `<span class="signal ko"></span>SNCF injoignable`;
  }
  try {
    const c = await fetch(`${API_SERVEUR}/api/config`).then(r => r.json());
    if (c.dernier_controle) {
      const min = Math.max(0, Math.round((Date.now() - new Date(c.dernier_controle)) / 60000));
      $("#etat-serveur").textContent = `Surveillance : contrôle il y a ${min} min`;
      $("#etat-serveur").title = "Le serveur vérifie chaque minute autour des publications SNCF, toutes les 10 minutes sinon, et chaque minute dès qu'une date est ciblée.";
    }
  } catch {
    $("#etat-serveur").textContent = "Surveillance injoignable";
  }
}

// ------------------------------------------------------------ calendrier

function libellesCourts(iso) {
  const t = etat.jours[iso];
  if (!t) return "";
  let h = "";
  if (t.ferie) h += `<span class="f">${esc(t.ferie)}</span>`;
  else if (t.pont) h += `<span class="f">Pont</span>`;
  if (t.zones.length) h += `<span class="v">Vac. ${t.zones.join("")}</span>`;
  return h;
}

function datesCiblees() {
  const w = alerteDuTrajet();
  return new Set(w?.targets || []);
}

function afficherResume() {
  const aller = etat.trains.filter(t => t.o === etat.o);
  const retour = etat.trains.filter(t => t.o === etat.d);
  const jours = new Set(etat.trains.map(t => t.date)).size;
  const nouv = etat.trains.filter(estNouveau).length;
  const cases = [
    [aller.length, `place${aller.length > 1 ? "s" : ""} ${nom(etat.o)} → ${nom(etat.d)}`],
    etat.ar ? [retour.length, `place${retour.length > 1 ? "s" : ""} ${nom(etat.d)} → ${nom(etat.o)}`] : [jours, `jour${jours > 1 ? "s" : ""} avec au moins une place`],
    etat.ar ? [etat.combos.length, `aller${etat.combos.length > 1 ? "s" : ""}-retour${etat.combos.length > 1 ? "s" : ""} (${etat.sejourMin}–${etat.sejourMax} nuits)`] : [aller[0] ? fmtCourt(aller[0].date) : "—", "prochaine place"],
    etat.stats[`${etat.o}>${etat.d}`]?.snaps?.length
      ? [nouv, `nouvelle${nouv > 1 ? "s" : ""} à la dernière publication`]
      : ["—", "nouveautés : surveille ce trajet (onglet Alertes) pour les voir"],
  ];
  $("#resume").innerHTML = cases.map(([v, l]) => `<div><div class="val">${esc(v)}</div><div class="lib">${esc(l)}</div></div>`).join("");
}

function afficherCalendrier() {
  afficherResume();
  const auj = isoLocal();
  const fin = ajouterJours(auj, 30);
  const parJour = {};
  for (const t of etat.trains) (parJour[t.date] ||= []).push(t);
  const departsAR = new Set(etat.combos.map(c => c.aller.date));
  const cibles = datesCiblees();

  $("#sous-titre-cal").textContent = "Seuls les jours avec une place à 0 € sont chiffrés. Clique sur un jour pour le détail.";
  $("#legende").innerHTML = `
    <span><b class="mono" style="color:var(--accent)">→ 3</b> places à l'aller</span>
    ${etat.ar ? `<span><b class="mono" style="color:var(--retour)">← 2</b> places au retour</span><span><b>A/R</b> départ d'un aller-retour</span>` : ""}
    <span><b style="color:var(--accent-encre)">NOUV.</b> apparue à la dernière publication</span>
    <span><i style="background:var(--vac)"></i>vacances scolaires</span>
    <span><i style="border:2px dashed var(--alerte)"></i>date ciblée</span>`;

  let html = "";
  for (let m = new Date(versDate(auj).getFullYear(), versDate(auj).getMonth(), 1); isoLocal(m) <= fin; m.setMonth(m.getMonth() + 1)) {
    html += `<div class="mois"><h3>${MOIS[m.getMonth()]} ${m.getFullYear()}</h3><div class="grille">`;
    html += JOURS_COURTS.map(j => `<div class="js">${j}</div>`).join("");
    const premier = (m.getDay() + 6) % 7;
    for (let i = 0; i < premier; i++) html += `<div class="jour hors"></div>`;
    const nb = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= nb; n++) {
      const iso = isoLocal(new Date(m.getFullYear(), m.getMonth(), n));
      const futur = iso >= auj && iso <= fin;
      const liste = parJour[iso] || [];
      const nA = liste.filter(t => t.o === etat.o).length, nR = liste.filter(t => t.o === etat.d).length;
      const classes = ["jour"];
      if (!futur) classes.push("hors");
      if (etat.jours[iso]?.zones.length) classes.push("vac");
      if (iso === auj) classes.push("aujourdhui");
      if (liste.length) classes.push("dispo");
      if (iso === etat.jourChoisi) classes.push("choisi");
      if (cibles.has(iso)) classes.push("cible");
      let c = `<span class="n">${n}</span>`;
      if (nA) c += `<span class="compte aller" title="${nA} place(s) à l'aller">→ ${nA}</span>`;
      if (nR) c += `<span class="compte retour" title="${nR} place(s) au retour">← ${nR}</span>`;
      let marques = "";
      if (liste.some(estNouveau)) marques += `<span class="nouv">NOUV.</span>`;
      if (departsAR.has(iso)) marques += `<span class="ar">A/R</span>`;
      if (cibles.has(iso)) marques += `<span class="ci">CIBLE</span>`;
      marques += libellesCourts(iso);
      if (marques) c += `<span class="marques">${marques}</span>`;
      const titre = [liste.length ? `${liste.length} place(s)` : "Aucune place à 0 €", ...(etat.jours[iso]?.libelles || [])].join(" · ");
      html += futur
        ? `<button type="button" class="${classes.join(" ")}" data-jour="${iso}" title="${esc(titre)}">${c}</button>`
        : `<div class="${classes.join(" ")}">${c}</div>`;
    }
    html += `</div></div>`;
  }
  $("#calendrier").innerHTML = html;
  $("#calendrier").querySelectorAll("[data-jour]").forEach(b => b.onclick = () => afficherDetail(b.dataset.jour));
  afficherListeAR();
}

function afficherListeAR() {
  if (!etat.ar) return;
  $("#ar-info").textContent = `Retour entre ${etat.sejourMin} et ${etat.sejourMax} nuit(s) après l'aller.`;
  if (!etat.combos.length) {
    $("#liste-ar").innerHTML = `<div class="vide">Aucun aller-retour complet pour l'instant. Une alerte te préviendra dès qu'il y en a un.</div>`;
    return;
  }
  const MAX = 60;
  $("#liste-ar").innerHTML = `<table class="tableau"><thead><tr><th>Aller</th><th>Retour</th><th class="num">Nuits</th></tr></thead><tbody>${
    etat.combos.slice(0, MAX).map(c => `<tr class="cliquable" data-jour="${c.aller.date}">
      <td><span class="mono">${fmtCourt(c.aller.date)} ${c.aller.dep} → ${c.aller.arr}</span> ${estNouveau(c.aller) ? `<span class="tag nouv">nouv.</span>` : ""}</td>
      <td><span class="mono">${fmtCourt(c.retour.date)} ${c.retour.dep} → ${c.retour.arr}</span> ${estNouveau(c.retour) ? `<span class="tag nouv">nouv.</span>` : ""}</td>
      <td class="num">${c.nuits}</td></tr>`).join("")}</tbody></table>
    ${etat.combos.length > MAX ? `<p class="note" style="padding:10px 14px">Les ${MAX} premiers sur ${etat.combos.length}. Réduis la durée de séjour ou clique sur un jour pour affiner.</p>` : ""}`;
  $("#liste-ar").querySelectorAll("[data-jour]").forEach(tr => tr.onclick = () => afficherDetail(tr.dataset.jour));
}

// ------------------------------------------------------------ probabilités (historique du serveur)

// Pour une date sans place : part des cas passés où une place est apparue plus tard, selon le délai
function chanceApparition(stats, delai) {
  if (!stats?.snaps?.length) return null;
  const snaps = stats.snaps.map(s => isoLocal(new Date(s)));
  const parDate = {};
  for (const [date, i, l] of stats.jours) (parDate[date] ||= []).push([i, l]);
  let cas = 0, succes = 0;
  for (const [date, obs] of Object.entries(parDate)) {
    if (date >= isoLocal()) continue;                 // voyage pas encore passé : issue inconnue
    obs.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < obs.length; k++) {
      const [i, l] = obs[k];
      const x = ecartJours(snaps[i], date);
      if (l || Math.abs(x - delai) > 2) continue;
      cas++;
      if (obs.slice(k + 1).some(o => o[1])) succes++;
    }
  }
  return cas >= 5 ? { p: Math.round(100 * succes / cas), cas } : null;
}

// ------------------------------------------------------------ détail d'un jour

function alerteDuTrajet() {
  return (etat.alertes || []).find(w => (w.o === etat.o && w.d === etat.d) || (w.mode === "ar" && w.o === etat.d && w.d === etat.o));
}

function lignesTrains(liste) {
  return liste.map(t => `<tr>
    <td><div class="h">${t.dep} <small>→ ${t.arr}</small></div>
      <div class="meta">${duree(t.dep, t.arr)} · train ${esc(t.train)} ${estNouveau(t) ? `<span class="tag nouv">nouv.</span>` : ""}</div></td>
    <td class="actions">
      <a class="btn petit" href="${SNCF_CONNECT}" target="_blank" rel="noopener" title="Ouvre SNCF Connect">Réserver</a>
      <button class="btn petit" data-rappel="${t.date}|${t.dep}|${t.arr}|${esc(t.train)}|${t.o}|${t.d}" title="Me rappeler de confirmer à J-2 et J-1">Rappel J-2</button>
    </td></tr>`).join("");
}

function afficherDetail(iso) {
  etat.jourChoisi = iso;
  ecrireHash();
  document.querySelectorAll(".jour.choisi").forEach(j => j.classList.remove("choisi"));
  document.querySelector(`.jour[data-jour="${iso}"]`)?.classList.add("choisi");

  const liste = etat.trains.filter(t => t.date === iso);
  const aller = liste.filter(t => t.o === etat.o), retour = liste.filter(t => t.o === etat.d);
  const infos = etat.jours[iso]?.libelles || [];
  const w = alerteDuTrajet();
  const cible = w?.targets?.includes(iso);
  const delai = ecartJours(isoLocal(), iso);
  const combos = etat.combos.filter(c => c.aller.date === iso);

  const tableau = (titre, l, od) => {
    const p = chanceApparition(etat.stats[od], delai);
    return `<div class="sens"><span>${esc(titre)}</span><span>${l.length} place${l.length > 1 ? "s" : ""}</span></div>
      ${l.length
        ? `<table class="trains">${lignesTrains(l)}</table>`
        : `<p class="note" style="padding:4px 14px 10px">Aucune place à 0 € pour l'instant.${p ? ` Historiquement, à J-${delai}, une place est apparue ensuite dans <b>${p.p} %</b> des cas (${p.cas} observations).` : ""}</p>`}`;
  };

  let h = `<div class="bloc">
    <div class="detail-tete">
      <button class="btn petit fermer-detail" id="fermer-detail">Fermer</button>
      <h2>${fmtLong(iso)}</h2>
      <div class="libelles">${delai === 0 ? "Aujourd'hui" : `Dans ${delai} jour${delai > 1 ? "s" : ""}`}${infos.length ? " · " + esc(infos.join(" · ")) : ""}</div>
      <div class="detail-actions">
        <button class="btn petit" id="cibler" aria-pressed="${cible ? "true" : "false"}"
          title="Surveillance chaque minute et alerte prioritaire pour cette date">${cible ? "Date ciblée" : "Cibler cette date"}</button>
        <button class="btn petit" id="voir-corresp">Correspondances ce jour</button>
      </div>
    </div>
    ${tableau(`${nom(etat.o)} → ${nom(etat.d)}`, aller, `${etat.o}>${etat.d}`)}
    ${etat.ar ? tableau(`${nom(etat.d)} → ${nom(etat.o)}`, retour, `${etat.d}>${etat.o}`) : ""}
    ${combos.length ? `<div class="sens"><span>Allers-retours depuis ce jour</span><span>${combos.length}</span></div>
      <table class="trains">${combos.map(c => `<tr><td class="mono">${c.aller.dep} → ${c.aller.arr}</td>
        <td class="mono">retour ${fmtCourt(c.retour.date)} ${c.retour.dep}</td><td class="num mono discret">${c.nuits} n.</td></tr>`).join("")}</table>` : ""}
    <div class="proba">Rappel : un billet TGV Max se confirme entre J-2 et la veille 17 h, sinon il est annulé.</div>
  </div>`;
  const panneau = $("#detail");
  panneau.innerHTML = h;
  panneau.classList.add("ouvert");
  $("#fermer-detail").onclick = () => {
    panneau.classList.remove("ouvert");
    etat.jourChoisi = null;
    ecrireHash();
    document.querySelectorAll(".jour.choisi").forEach(j => j.classList.remove("choisi"));
    afficherAideDetail();
  };
  $("#cibler").onclick = () => basculerCible(iso);
  $("#voir-corresp").onclick = () => { $("#corresp-date").value = iso; changerVue("correspondances"); chercherCorrespondances(); };
  panneau.querySelectorAll("[data-rappel]").forEach(b => b.onclick = () => ajouterRappel(b.dataset.rappel, b));
}

function afficherAideDetail() {
  $("#detail").innerHTML = `<div class="bloc"><div class="vide">Clique sur un jour du calendrier pour voir chaque train, réserver, programmer un rappel ou cibler la date.</div></div>`;
}

async function exigerCode() {
  if (codeAcces()) return true;
  changerVue("alertes");
  toast("Saisis d'abord ton code d'accès pour gérer les alertes.");
  return false;
}

async function basculerCible(iso) {
  if (!await exigerCode()) return;
  try {
    let w = alerteDuTrajet();
    if (!w) {
      const r = await serveur("/api/watches", { methode: "POST", corps: { o: etat.o, o_name: nom(etat.o), d: etat.d, d_name: nom(etat.d), mode: etat.ar ? "ar" : "aller", stay_min: etat.sejourMin, stay_max: etat.sejourMax } });
      await chargerAlertes();
      w = etat.alertes.find(x => x.id === r.id);
      toast("Ce trajet est maintenant surveillé.");
    }
    const deja = w.targets.includes(iso);
    await serveur("/api/targets", { methode: deja ? "DELETE" : "POST", corps: { watch_id: w.id, date: iso } });
    await chargerAlertes();
    toast(deja ? "Date retirée des cibles." : `${fmtLong(iso)} ciblé : contrôle chaque minute et alerte prioritaire.`);
    afficherCalendrier();
    afficherDetail(iso);
  } catch (e) { toast(e.message); }
}

async function ajouterRappel(v, bouton) {
  if (!await exigerCode()) return;
  const [date, dep, arr, train, o, d] = v.split("|");
  try {
    await serveur("/api/trips", { methode: "POST", corps: { date, dep, arr, train, o_name: nom(o), d_name: nom(d) } });
    bouton.textContent = "Rappel activé";
    bouton.disabled = true;
    toast("Tu seras prévenu à J-2 (9 h) et la veille (12 h) pour confirmer.");
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------ Où partir ?

function periode(type) {
  const auj = isoLocal();
  const j = jourSemaine(auj);
  if (type === "7") return [auj, ajouterJours(auj, 6)];
  let ven = ajouterJours(auj, (4 - j + 7) % 7);
  if (j >= 5) ven = ajouterJours(auj, -(j - 4));      // samedi / dimanche : ce week-end
  if (type === "weekend2") ven = ajouterJours(ven, 7);
  return [ven < auj ? auj : ven, ajouterJours(ven, 2)];
}

async function chercherDestinations(e) {
  e?.preventDefault();
  const o = codeDe($("#partir-gare"));
  if (!o) return toast("Choisis une gare de départ dans la liste.");
  const du = $("#partir-du").value, au = $("#partir-au").value;
  const zone = $("#res-partir");
  zone.innerHTML = `<div class="vide"><span class="tourne"></span>Recherche…</div>`;
  try {
    const trains = await placesDepuis(o, du, au);
    const parDest = {};
    for (const t of trains) (parDest[t.d] ||= []).push(t);
    const lignes = Object.entries(parDest).sort((a, b) => b[1].length - a[1].length);
    if (!lignes.length) { zone.innerHTML = `<div class="vide">Aucune place à 0 € depuis ${esc(nom(o))} sur cette période.</div>`; return; }
    zone.innerHTML = `<table class="tableau"><thead><tr><th>Destination</th><th class="num">Places</th><th>Jours</th><th>Premier départ</th></tr></thead><tbody>${
      lignes.map(([d, l]) => {
        const jours = [...new Set(l.map(t => t.date))];
        return `<tr class="cliquable" data-dest="${d}"><td><b>${esc(nom(d))}</b></td><td class="num">${l.length}</td>
          <td class="mono discret">${jours.map(fmtCourt).join(", ")}</td><td class="mono">${fmtCourt(l[0].date)} ${l[0].dep}</td></tr>`;
      }).join("")}</tbody></table>
      <p class="note" style="padding:10px 14px">${lignes.length} destination(s). Clique sur une ligne pour ouvrir son calendrier.</p>`;
    zone.querySelectorAll("[data-dest]").forEach(tr => tr.onclick = () => changerTrajet(o, tr.dataset.dest, true));
  } catch (err) { zone.innerHTML = `<div class="vide erreur">${esc(err.message)}</div>`; }
}

// ------------------------------------------------------------ Correspondances

async function chercherCorrespondances(e) {
  e?.preventDefault();
  const date = $("#corresp-date").value;
  const min = Number($("#corresp-min").value);
  const zone = $("#res-corresp");
  $("#corresp-trajet").textContent = `${nom(etat.o)} → ${nom(etat.d)}`;
  if (!date) return;
  zone.innerHTML = `<div class="vide"><span class="tourne"></span>Recherche…</div>`;
  try {
    const [depuis, vers] = await Promise.all([placesDepuis(etat.o, date, date), placesVers(etat.d, date, date)]);
    const directs = depuis.filter(t => t.d === etat.d);
    const res = correspondances(depuis, vers, etat.o, etat.d, min);
    let h = directs.length
      ? `<p class="note" style="padding:10px 14px 0">${directs.length} train(s) direct(s) à 0 € ce jour : ${directs.map(t => `<span class="mono">${t.dep}</span>`).join(", ")}.</p>` : "";
    if (!res.length) {
      zone.innerHTML = h + `<div class="vide">Aucune correspondance à 0 € le ${fmtLong(date)}.</div>`;
      return;
    }
    h += `<table class="tableau"><thead><tr><th>Départ</th><th>Correspondance</th><th>Arrivée</th><th class="num">Durée totale</th><th>Trains</th></tr></thead><tbody>${
      res.slice(0, 40).map(c => `<tr>
        <td class="mono"><b>${c.a.dep}</b></td>
        <td>${esc(nom(c.a.d))} ${c.memeTrain
          ? `<span class="tag nouv" title="Tu restes dans le même train : un billet jusqu'à ${esc(nom(c.a.d))}, un autre ensuite">même train, 2 billets</span>`
          : `<span class="mono discret">${c.a.arr} → ${c.b.dep} (${Math.floor(c.attente / 60)} h ${String(c.attente % 60).padStart(2, "0")})</span>`}</td>
        <td class="mono"><b>${c.b.arr}</b></td>
        <td class="num">${Math.floor(c.total / 60)} h ${String(c.total % 60).padStart(2, "0")}</td>
        <td class="mono discret">${esc(c.a.train)} + ${esc(c.b.train)}</td></tr>`).join("")}</tbody></table>`;
    zone.innerHTML = h;
  } catch (err) { zone.innerHTML = `<div class="vide erreur">${esc(err.message)}</div>`; }
}

// ------------------------------------------------------------ Alertes

async function chargerAlertes() {
  if (!codeAcces()) { etat.alertes = null; return; }
  try { etat.alertes = await serveur("/api/watches"); }
  catch (e) { if (e.statut === 401) memoriserCode(""); etat.alertes = null; }
}

function nomAppareil() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh.*Mobile/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "PC Windows";
  if (/Mac/.test(ua)) return "Mac";
  return "Appareil";
}

async function abonnementActuel() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.register("sw.js");
  return { reg, abo: await reg.pushManager.getSubscription() };
}

async function afficherAppareil() {
  const zone = $("#appareil");
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installe = matchMedia("(display-mode: standalone)").matches || navigator.standalone;

  if (!codeAcces()) {
    zone.innerHTML = `<form class="formulaire" id="form-code" style="padding:0">
      <label class="champ"><span>Code d'accès</span><input type="password" id="code" placeholder="XXXX-XXXX" autocomplete="current-password" required></label>
      <button class="btn principal">Valider</button>
      <p class="note" style="flex-basis:100%">Le code protège tes alertes : il n'est demandé qu'une fois par appareil.</p></form>`;
    $("#form-code").onsubmit = async e => {
      e.preventDefault();
      memoriserCode($("#code").value.trim().toUpperCase());
      try {
        await serveur("/api/auth", { methode: "POST" });
        await chargerAlertes();
        afficherFavoris();
        afficherAlertes();
        toast("Code accepté.");
      } catch { memoriserCode(""); toast("Code incorrect."); }
    };
    return;
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    zone.innerHTML = ios && !installe
      ? `<p class="note">Sur iPhone, les notifications web demandent d'installer le site : bouton <b>Partager</b> → <b>Sur l'écran d'accueil</b>, puis ouvre <b>TGV Max</b> depuis l'icône et reviens ici.</p>`
      : `<p class="note">Ce navigateur ne gère pas les notifications web. Utilise Chrome, Edge, Firefox ou Safari récent.</p>`;
    return;
  }

  const { reg, abo } = await abonnementActuel();
  const permission = Notification.permission;
  if (abo && permission === "granted") {
    zone.innerHTML = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span><span class="signal"></span><b>Notifications actives</b> sur cet appareil (${esc(nomAppareil())}).</span>
      <button class="btn petit" id="tester">Envoyer un test</button>
      <button class="btn petit danger" id="desactiver">Désactiver</button></div>`;
    // L'abonnement est (ré)enregistré côté serveur à chaque visite : rien n'est perdu si le serveur l'avait oublié
    serveur("/api/devices", { methode: "POST", corps: { subscription: abo.toJSON(), label: nomAppareil() } }).catch(() => {});
    $("#tester").onclick = async () => {
      try { await serveur("/api/test", { methode: "POST", corps: { endpoint: abo.endpoint } }); toast("Notification de test envoyée."); }
      catch (e) { toast(e.message); }
    };
    $("#desactiver").onclick = async () => {
      await serveur("/api/devices", { methode: "DELETE", corps: { endpoint: abo.endpoint } }).catch(() => {});
      await abo.unsubscribe();
      toast("Notifications désactivées sur cet appareil.");
      afficherAppareil();
      afficherAlertes();
    };
    return;
  }

  zone.innerHTML = permission === "denied"
    ? `<p class="note erreur">Les notifications sont bloquées pour ce site. Autorise-les dans les réglages du navigateur (icône à gauche de l'adresse), puis recharge la page.</p>`
    : `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <button class="btn accent" id="activer">Activer les notifications</button>
        <span class="note">Ton navigateur va te demander l'autorisation. Tu recevras les nouvelles places, les allers-retours et les rappels J-2.</span></div>`;
  $("#activer")?.addEventListener("click", async () => {
    try {
      if (await Notification.requestPermission() !== "granted") { afficherAppareil(); return; }
      const cfg = await fetch(`${API_SERVEUR}/api/config`).then(r => r.json());
      const cle = Uint8Array.from(atob(cfg.vapid.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      const nouvel = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cle });
      await serveur("/api/devices", { methode: "POST", corps: { subscription: nouvel.toJSON(), label: nomAppareil() } });
      await serveur("/api/test", { methode: "POST", corps: { endpoint: nouvel.endpoint } });
      toast("Notifications activées : une notification de test arrive.");
      afficherAppareil();
      afficherAlertes();
    } catch (e) { toast(`Activation impossible : ${e.message}`); }
  });
}

const NOMS_JOURS = ["L", "M", "M", "J", "V", "S", "D"];

async function afficherAlertes() {
  const zone = $("#zone-privee");
  if (!codeAcces()) { zone.innerHTML = ""; return; }
  zone.innerHTML = `<div class="bloc"><div class="vide"><span class="tourne"></span>Chargement…</div></div>`;
  try {
    const [watches, appareils, voyages] = await Promise.all([serveur("/api/watches"), serveur("/api/devices"), serveur("/api/trips")]);
    etat.alertes = watches;
    const fmtD = s => s ? new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    zone.innerHTML = `
      <div class="bloc">
        <div class="bloc-tete"><h2>Trajets surveillés</h2><span class="discret">Une notification à chaque nouvelle place, sur tous tes appareils.</span></div>
        <div class="defile"><table class="tableau"><thead><tr><th>Trajet</th><th>Jours</th><th>Départ entre</th><th>Séjour</th><th>Dates ciblées</th><th></th></tr></thead><tbody>
        ${watches.length ? watches.map(w => `<tr data-w="${w.id}">
          <td><b>${esc(w.o_name)} ${w.mode === "ar" ? "⇄" : "→"} ${esc(w.d_name)}</b>${w.active ? "" : ` <span class="tag">en pause</span>`}</td>
          <td><div class="coche">${NOMS_JOURS.map((j, i) => `<label title="${["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"][i]}"><input type="checkbox" data-jourw="${i}" ${w.days.includes(String(i)) ? "checked" : ""}><span>${j}</span></label>`).join("")}</div></td>
          <td style="white-space:nowrap"><input type="time" data-champ="h_min" value="${w.h_min}" style="width:96px"> – <input type="time" data-champ="h_max" value="${w.h_max}" style="width:96px"></td>
          <td style="white-space:nowrap">${w.mode === "ar" ? `<input type="number" data-champ="stay_min" value="${w.stay_min}" min="0" max="30" style="width:52px"> à <input type="number" data-champ="stay_max" value="${w.stay_max}" min="0" max="30" style="width:52px"> n.` : "—"}</td>
          <td class="mono">${w.targets.length ? w.targets.map(t => `<button class="btn petit" data-retirer-cible="${t}" title="Retirer">${fmtCourt(t)} ✕</button>`).join(" ") : `<span class="discret">aucune</span>`}</td>
          <td class="actions" style="white-space:nowrap">
            <button class="btn petit" data-ouvrir>Calendrier</button>
            <button class="btn petit" data-pause>${w.active ? "Pause" : "Reprendre"}</button>
            <button class="btn petit danger" data-suppr>Supprimer</button></td></tr>`).join("")
        : `<tr><td colspan="6" class="vide">Aucun trajet surveillé.</td></tr>`}
        </tbody></table></div>
        <div class="formulaire" style="border-top:1px solid var(--trait)">
          <span>Surveiller <b>${esc(nom(etat.o))} ${etat.ar ? "⇄" : "→"} ${esc(nom(etat.d))}</b> (le trajet affiché en haut)</span>
          <button class="btn principal" id="ajouter-alerte">Ajouter</button>
        </div>
      </div>
      <div class="deux">
        <div class="bloc">
          <div class="bloc-tete"><h2>Appareils notifiés</h2></div>
          <table class="tableau"><tbody>${appareils.length ? appareils.map(a => `<tr>
            <td><b>${esc(a.label)}</b><div class="note">dernier envoi réussi : ${fmtD(a.last_ok)}</div></td>
            <td class="actions"><button class="btn petit" data-test="${esc(a.endpoint)}">Tester</button>
              <button class="btn petit danger" data-oublier="${esc(a.endpoint)}">Retirer</button></td></tr>`).join("")
            : `<tr><td class="vide">Aucun appareil.</td></tr>`}</tbody></table>
        </div>
        <div class="bloc">
          <div class="bloc-tete"><h2>Rappels de confirmation</h2><span class="discret">J-2 à 9 h et la veille à 12 h</span></div>
          <table class="tableau"><tbody>${voyages.length ? voyages.map(v => `<tr>
            <td class="mono">${fmtCourt(v.date)} ${v.dep}</td><td>${esc(v.o_name)} → ${esc(v.d_name)}</td>
            <td class="actions"><button class="btn petit danger" data-trip="${v.id}">Retirer</button></td></tr>`).join("")
            : `<tr><td class="vide">Aucun. Utilise « Rappel J-2 » sur un train dans le calendrier.</td></tr>`}</tbody></table>
        </div>
      </div>
      <p class="note">Les trajets surveillés sont contrôlés chaque minute autour des publications SNCF (≈ 6 h 25 et 12 h), toutes les 10 minutes le reste du temps, et chaque minute toute la journée dès qu'une date est ciblée.
        <button class="btn lien" id="oublier-code">Oublier le code sur cet appareil</button></p>`;

    zone.querySelectorAll("tr[data-w]").forEach(tr => {
      const id = Number(tr.dataset.w);
      const w = watches.find(x => x.id === id);
      const maj = async corps => {
        try { await serveur(`/api/watches/${id}`, { methode: "PATCH", corps }); toast("Alerte mise à jour."); await chargerAlertes(); }
        catch (e) { toast(e.message); }
      };
      tr.querySelectorAll("[data-jourw]").forEach(c => c.onchange = () =>
        maj({ days: [...tr.querySelectorAll("[data-jourw]")].filter(x => x.checked).map(x => x.dataset.jourw).join("") }));
      tr.querySelectorAll("[data-champ]").forEach(c => c.onchange = () =>
        maj({ [c.dataset.champ]: c.type === "number" ? Number(c.value) : c.value }));
      tr.querySelector("[data-ouvrir]").onclick = () => changerTrajet(w.o, w.d, w.mode === "ar");
      tr.querySelector("[data-pause]").onclick = async () => { await maj({ active: !w.active }); afficherAlertes(); };
      tr.querySelector("[data-suppr]").onclick = async () => {
        if (!confirm(`Ne plus surveiller ${w.o_name} → ${w.d_name} ?`)) return;
        await serveur(`/api/watches/${id}`, { methode: "DELETE" });
        afficherAlertes(); afficherFavoris();
      };
      tr.querySelectorAll("[data-retirer-cible]").forEach(b => b.onclick = async () => {
        await serveur("/api/targets", { methode: "DELETE", corps: { watch_id: id, date: b.dataset.retirerCible } });
        afficherAlertes();
      });
    });
    $("#ajouter-alerte").onclick = async () => {
      if (watches.some(w => w.o === etat.o && w.d === etat.d)) return toast("Ce trajet est déjà surveillé.");
      try {
        await serveur("/api/watches", { methode: "POST", corps: { o: etat.o, o_name: nom(etat.o), d: etat.d, d_name: nom(etat.d), mode: etat.ar ? "ar" : "aller", stay_min: etat.sejourMin, stay_max: etat.sejourMax } });
        toast("Trajet ajouté : tu seras prévenu des nouvelles places.");
        afficherAlertes(); afficherFavoris();
      } catch (e) { toast(e.message); }
    };
    zone.querySelectorAll("[data-test]").forEach(b => b.onclick = async () => {
      const r = await serveur("/api/test", { methode: "POST", corps: { endpoint: b.dataset.test } });
      toast(r.bilan?.[0]?.statut === 201 ? "Test envoyé." : `Réponse du service : ${r.bilan?.[0]?.statut}`);
    });
    zone.querySelectorAll("[data-oublier]").forEach(b => b.onclick = async () => {
      await serveur("/api/devices", { methode: "DELETE", corps: { endpoint: b.dataset.oublier } });
      afficherAlertes();
    });
    zone.querySelectorAll("[data-trip]").forEach(b => b.onclick = async () => {
      await serveur(`/api/trips/${b.dataset.trip}`, { methode: "DELETE" });
      afficherAlertes();
    });
    $("#oublier-code").onclick = () => { memoriserCode(""); etat.alertes = null; afficherAppareil(); afficherAlertes(); afficherFavoris(); };
  } catch (e) {
    zone.innerHTML = `<div class="bloc"><div class="vide erreur">${esc(e.message)}</div></div>`;
  }
}

// ------------------------------------------------------------ Statistiques

function chargerChart() {
  if (window.Chart) return Promise.resolve();
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
    s.onload = ok; s.onerror = ko;
    document.head.appendChild(s);
  });
}
const graphes = [];

async function afficherStats() {
  const zone = $("#stats");
  const ods = [[etat.o, etat.d], ...(etat.ar ? [[etat.d, etat.o]] : [])];
  const series = await Promise.all(ods.map(([o, d]) => chargerStats(o, d)));
  const nb = Math.max(...series.map(s => s.snaps.length));
  if (!nb) {
    zone.innerHTML = `<div class="bloc"><div class="vide">Pas encore d'historique pour ${esc(nom(etat.o))} → ${esc(nom(etat.d))}.<br>
      Ajoute ce trajet dans <b>Alertes</b> : chaque publication SNCF sera enregistrée et les probabilités se rempliront jour après jour.</div></div>`;
    return;
  }
  zone.innerHTML = `
    <p class="note" style="margin-bottom:12px">Basé sur <b>${nb}</b> publications SNCF enregistrées depuis le ${fmtLong(isoLocal(new Date(series[0].snaps[0] || series[1]?.snaps[0])))}.
      Une barre = part des publications où au moins un train avait une place à 0 €.${nb < 20 ? " Encore peu de données : les chiffres se préciseront avec le temps." : ""}</p>
    <div class="bloc"><div class="bloc-tete"><h2>Chance qu'une place apparaisse plus tard</h2><span class="discret">Quand un jour est complet à J-x, part des cas où une place s'est libérée ensuite.</span></div><div class="graph"><canvas id="g-apparition"></canvas></div></div>
    <div class="bloc"><div class="bloc-tete"><h2>Par date de voyage</h2></div><div class="graph"><canvas id="g-date"></canvas></div></div>
    <div class="bloc"><div class="bloc-tete"><h2>Selon le type de jour</h2><span class="discret">Un jour peut appartenir à plusieurs catégories.</span></div><div class="graph"><canvas id="g-type"></canvas></div></div>
    <div class="deux">
      <div class="bloc"><div class="bloc-tete"><h2>Par jour de la semaine</h2></div><div class="graph"><canvas id="g-semaine"></canvas></div></div>
      <div class="bloc"><div class="bloc-tete"><h2>Selon le délai avant le départ</h2></div><div class="graph"><canvas id="g-delai"></canvas></div></div>
    </div>
    <div class="bloc"><div class="bloc-tete"><h2>Par horaire de train</h2><span class="discret">Part des observations où ce train avait une place.</span></div><div class="graph"><canvas id="g-train"></canvas></div></div>`;
  try { await chargerChart(); } catch { zone.insertAdjacentHTML("afterbegin", `<p class="note erreur">Graphiques indisponibles (connexion).</p>`); return; }

  // Types de jours sur toute la période observée
  const toutes = series.flatMap(s => s.jours.map(j => j[0])).sort();
  const types = etat.calFr ? typesDeJours(etat.calFr, toutes[0], ajouterJours(isoLocal(), 31)) : {};

  const agreg = series.map(s => {
    const snaps = s.snaps.map(x => isoLocal(new Date(x)));
    const r = { date: {}, semaine: {}, delai: {}, type: {}, apparition: {} };
    const add = (o, k, v) => { const x = (o[k] ||= [0, 0]); x[0] += v; x[1]++; };
    const parDate = {};
    for (const [date, i, l] of s.jours) {
      (parDate[date] ||= []).push([i, l]);
      add(r.date, date, l);
      add(r.semaine, jourSemaine(date), l);
      const x = ecartJours(snaps[i], date);
      if (x >= 0) add(r.delai, Math.min(x, 30), l);
      (types[date]?.tags || []).forEach(t => add(r.type, t, l));
    }
    for (const [date, obs] of Object.entries(parDate)) {
      if (date >= isoLocal()) continue;               // voyage pas encore passé : issue inconnue
      obs.sort((a, b) => a[0] - b[0]);
      obs.forEach(([i, l], k) => {
        if (l) return;
        const x = ecartJours(snaps[i], date);
        const tranche = x <= 2 ? "J-0 à J-2" : x <= 6 ? "J-3 à J-6" : x <= 13 ? "J-7 à J-13" : x <= 20 ? "J-14 à J-20" : "J-21 et plus";
        add(r.apparition, tranche, obs.slice(k + 1).some(o => o[1]) ? 1 : 0);
      });
    }
    r.train = Object.fromEntries(s.trains.map(([dep, l, n]) => [dep, [l, n]]));
    return r;
  });

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  Chart.defaults.color = css("--discret");
  Chart.defaults.borderColor = css("--trait");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11.5;
  const couleurs = [css("--accent"), css("--retour")];
  const libelles = ods.map(([o, d]) => `${nom(o)} → ${nom(d)}`);
  const pct = x => x ? Math.round(100 * x[0] / x[1]) : null;
  const options = (titres, details) => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    scales: { y: { min: 0, max: 100, ticks: { callback: v => v + " %" } }, x: { grid: { display: false } } },
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: {
        title: it => titres ? titres[it[0].dataIndex] : it[0].label,
        afterTitle: it => details ? details[it[0].dataIndex] : "",
        label: c => `${c.dataset.label} : ${c.raw ?? "–"} %` } },
    },
  });
  const barres = (id, cles, champ, etiquettes, titres, details) => {
    graphes.push(new Chart(document.getElementById(id), {
      type: "bar",
      data: { labels: etiquettes, datasets: agreg.map((a, i) => ({ label: libelles[i], data: cles.map(k => pct(a[champ][k])), backgroundColor: couleurs[i], borderRadius: 0, maxBarThickness: 28 })) },
      options: options(titres, details),
    }));
  };
  graphes.splice(0).forEach(g => g.destroy());

  const tranches = ["J-21 et plus", "J-14 à J-20", "J-7 à J-13", "J-3 à J-6", "J-0 à J-2"];
  barres("g-apparition", tranches, "apparition", tranches);
  const dates = [...new Set(agreg.flatMap(a => Object.keys(a.date)))].sort();
  barres("g-date", dates, "date", dates.map(d => d.slice(8, 10) + "/" + d.slice(5, 7)), dates.map(fmtLong), dates.map(d => (types[d]?.libelles || []).join(" · ")));
  const cats = Object.keys(CATEGORIES).filter(c => agreg.some(a => a.type[c]));
  barres("g-type", cats, "type", cats.map(c => CATEGORIES[c]));
  barres("g-semaine", [0, 1, 2, 3, 4, 5, 6], "semaine", JOURS_COURTS);
  const delais = [...Array(31).keys()].reverse();
  barres("g-delai", delais, "delai", delais.map(x => x === 30 ? "30+" : String(x)), delais.map(x => `J-${x}`));
  const horaires = [...new Set(agreg.flatMap(a => Object.keys(a.train)))].sort();
  barres("g-train", horaires, "train", horaires);
}

// ------------------------------------------------------------ navigation

function changerVue(vue) {
  etat.vue = vue;
  document.querySelectorAll(".onglets [data-vue]").forEach(b => b.setAttribute("aria-selected", b.dataset.vue === vue));
  document.querySelectorAll(".vue").forEach(s => s.hidden = s.id !== "vue-" + vue);
  ecrireHash();
  if (vue === "alertes") { afficherAppareil(); afficherAlertes(); }
  if (vue === "stats") afficherStats();
  if (vue === "correspondances") {
    $("#corresp-trajet").textContent = `${nom(etat.o)} → ${nom(etat.d)}`;
    if (!$("#corresp-date").value) $("#corresp-date").value = etat.jourChoisi || isoLocal();
  }
  if (vue === "partir" && !$("#partir-gare").value) remplirGare($("#partir-gare"), etat.o);
}

// ------------------------------------------------------------ démarrage

async function demarrer() {
  const memo = lireLocal("trajet", null);
  if (memo) Object.assign(etat, memo);
  lireHash();

  document.querySelectorAll(".onglets [data-vue]").forEach(b => b.onclick = () => changerVue(b.dataset.vue));
  $("#mode-aller").onclick = () => { etat.ar = false; afficherMode(); charger(); };
  $("#mode-ar").onclick = () => { etat.ar = true; afficherMode(); charger(); };
  $("#inverser").onclick = () => changerTrajet(etat.d, etat.o);
  const majSejour = () => {
    etat.sejourMin = Math.max(0, Number($("#sejour-min").value) || 0);
    etat.sejourMax = Math.max(etat.sejourMin, Number($("#sejour-max").value) || 0);
    etat.combos = etat.ar ? allersRetours(etat.trains, etat.o, etat.d, etat.sejourMin, etat.sejourMax) : [];
    ecrireHash();
    afficherCalendrier();
  };
  $("#sejour-min").onchange = majSejour;
  $("#sejour-max").onchange = majSejour;
  $("#form-trajet").onsubmit = e => {
    e.preventDefault();
    const o = codeDe($("#gare-o")), d = codeDe($("#gare-d"));
    if (!o || !d) return toast("Choisis les gares dans la liste proposée.");
    if (o === d) return toast("Départ et arrivée identiques.");
    changerTrajet(o, d);
  };
  $("#actualiser").onclick = async () => {
    const b = $("#actualiser");
    b.classList.add("tourne"); b.disabled = true;
    etat.stats = {};
    await Promise.all([charger({ force: true }), afficherEtat()]);
    b.classList.remove("tourne"); b.disabled = false;
  };
  $("#form-partir").onsubmit = chercherDestinations;
  document.querySelectorAll("[data-periode]").forEach(b => b.onclick = () => {
    const [du, au] = periode(b.dataset.periode);
    $("#partir-du").value = du; $("#partir-au").value = au;
    chercherDestinations();
  });
  const [du, au] = periode("weekend");
  $("#partir-du").value = du; $("#partir-au").value = au;
  $("#form-corresp").onsubmit = chercherCorrespondances;
  window.addEventListener("hashchange", () => {
    const avant = `${etat.o}${etat.d}${etat.ar}`;
    lireHash();
    if (`${etat.o}${etat.d}${etat.ar}` !== avant) changerTrajet(etat.o, etat.d, etat.ar);
    else if (etat.jourChoisi) afficherDetail(etat.jourChoisi);
  });

  afficherAideDetail();
  $("#sejour-min").value = etat.sejourMin;
  $("#sejour-max").value = etat.sejourMax;
  afficherMode();
  afficherEtat();
  setInterval(afficherEtat, 60000);

  try {
    etat.gares = await gares();
    etat.parCode = new Map(etat.gares.map(g => [g.code, g]));
  } catch { toast("Liste des gares indisponible."); }
  remplirGare($("#gare-o"), etat.o);
  remplirGare($("#gare-d"), etat.d);
  autocompletion($("#gare-o"));
  autocompletion($("#gare-d"));
  autocompletion($("#partir-gare"));

  calendrierFrance().then(c => {
    etat.calFr = c;
    etat.jours = typesDeJours(c, isoLocal(), ajouterJours(isoLocal(), 45));
    if (etat.trains.length || etat.vue === "calendrier") afficherCalendrier();
  }).catch(() => {});

  await chargerAlertes();
  afficherFavoris();
  changerVue(etat.vue);
  charger();
}

demarrer();
