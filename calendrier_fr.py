"""
Jours fériés, ponts et vacances scolaires (Antibes = zone B, Paris = zone C).
Sources officielles, mises en cache une semaine dans calendrier_fr.json :
  - https://calendrier.api.gouv.fr/jours-feries/metropole.json
  - data.education.gouv.fr, dataset fr-en-calendrier-scolaire
"""

import json
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

CACHE = Path(__file__).resolve().parent / "calendrier_fr.json"
URL_FERIES = "https://calendrier.api.gouv.fr/jours-feries/metropole.json"
URL_VACANCES = ("https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/"
                "fr-en-calendrier-scolaire/records")
ACADEMIES = {"Nice": "B", "Paris": "C"}   # Antibes est dans l'académie de Nice

# Catégories utilisées par le graphique « selon le type de jour »
CATEGORIES = {
    "normal": "Jour normal",
    "vacB": "Vacances zone B (Antibes)",
    "vacC": "Vacances zone C (Paris)",
    "depart": "Départ en vacances",
    "retour": "Retour de vacances",
    "ferie": "Jour férié",
    "pont": "Pont / week-end prolongé",
}


def _lire(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def _date_locale(iso):
    # Les dates sont en UTC (ex. 2026-10-16T22:00:00+00:00 = samedi 17 à minuit à Paris)
    return (datetime.fromisoformat(iso) + timedelta(hours=2)).date()


def _telecharger():
    feries = _lire(URL_FERIES)
    depuis = (date.today() - timedelta(days=400)).isoformat()
    academies = ", ".join(f'"{a}"' for a in ACADEMIES)
    where = f'location in ({academies}) and end_date >= "{depuis}"'
    vacances, offset = [], 0
    while True:
        params = urllib.parse.urlencode({"where": where, "limit": 100, "offset": offset})
        data = _lire(f"{URL_VACANCES}?{params}")
        for r in data["results"]:
            if r["population"] == "Enseignants":
                continue
            vacances.append({
                "nom": r["description"], "zone": ACADEMIES[r["location"]],
                "debut": _date_locale(r["start_date"]).isoformat(),
                "fin": _date_locale(r["end_date"]).isoformat(),   # fin exclue (jour de reprise)
            })
        offset += 100
        if offset >= data["total_count"]:
            break
    # dédoublonner
    vacances = [dict(t) for t in {tuple(sorted(v.items())) for v in vacances}]
    return {"maj": time.time(), "feries": feries, "vacances": vacances}


def _sources():
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else None
    if cache and time.time() - cache["maj"] < 7 * 86400:
        return cache
    try:
        frais = _telecharger()
        CACHE.write_text(json.dumps(frais, ensure_ascii=False, indent=1), encoding="utf-8")
        return frais
    except Exception as e:
        print(f"Calendrier fériés/vacances non mis à jour : {e}")
        return cache or {"feries": {}, "vacances": []}


def types_de_jours(debut, fin):
    """{date iso: {"tags": [...], "labels": [...]}} pour chaque jour de debut à fin inclus."""
    src = _sources()
    feries = src["feries"]
    debut, fin = date.fromisoformat(debut), date.fromisoformat(fin)

    # Jours de vacances par zone, avec début et fin de chaque période
    vac = {}          # iso -> {zone: nom}
    departs, retours, ponts_scolaires = set(), set(), set()
    for v in src["vacances"]:
        d0, d1 = date.fromisoformat(v["debut"]), date.fromisoformat(v["fin"])
        if "Pont" in v["nom"]:       # « Pont de l'Ascension » : pont, pas des vacances
            d = d0
            while d < d1:
                ponts_scolaires.add(d.isoformat())
                d += timedelta(days=1)
            continue
        if (d1 - d0).days <= 1:      # entrées d'un jour (« Début des vacances d'été »)
            continue
        d = d0
        while d < d1:
            vac.setdefault(d.isoformat(), {})[v["zone"]] = v["nom"]
            d += timedelta(days=1)
        for k in (-1, 0, 1):                         # vendredi soir, samedi, dimanche
            departs.add((d0 + timedelta(days=k)).isoformat())
        for k in (-2, -1):                           # samedi et dimanche avant la reprise
            retours.add((d1 + timedelta(days=k)).isoformat())

    # Ponts : lundi avant un mardi férié, vendredi après un jeudi férié
    def ferie(d):
        return d.isoformat() in feries

    def pont(d):
        return (d.weekday() < 5 and d.isoformat() in ponts_scolaires and not ferie(d)) or (
               (d.weekday() == 0 and ferie(d + timedelta(days=1)))
                or (d.weekday() == 4 and ferie(d - timedelta(days=1))))

    def repos(d):
        return d.weekday() >= 5 or ferie(d) or pont(d)

    # Week-end prolongé : bloc d'au moins 3 jours de repos consécutifs
    def bloc(d):
        g, dr = d, d
        while repos(g - timedelta(days=1)):
            g -= timedelta(days=1)
        while repos(dr + timedelta(days=1)):
            dr += timedelta(days=1)
        return (dr - g).days + 1

    jours = {}
    d = debut
    while d <= fin:
        k, tags, labels = d.isoformat(), [], []
        if ferie(d):
            tags.append("ferie"); labels.append(feries[k])
        if pont(d):
            labels.append("Pont")
        if repos(d) and bloc(d) >= 3:
            tags.append("pont")
            if not ferie(d) and not pont(d):
                labels.append("Week-end prolongé")
        for zone in ("B", "C"):
            if zone in vac.get(k, {}):
                tags.append("vac" + zone)
        if vac.get(k):
            noms = set(vac[k].values())
            labels.append(f'{" / ".join(sorted(noms))} (zone {"+".join(sorted(vac[k]))})')
        if k in departs:
            tags.append("depart"); labels.append("Départ en vacances")
        if k in retours:
            tags.append("retour"); labels.append("Retour de vacances")
        if not tags:
            tags.append("normal")
        jours[k] = {"tags": tags, "labels": labels}
        d += timedelta(days=1)
    return jours
