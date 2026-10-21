"""
Alerte TGV Max : Antibes <-> Paris
Interroge l'open data SNCF (dataset "tgvmax") et envoie une notification
dès qu'une nouvelle place à 0 € apparaît, avec une alerte spéciale quand
un aller-retour complet est possible. Chaque mise à jour SNCF est
enregistrée dans historique.json pour calculer les probabilités.

Lancer :  python tgvmax_alerte.py           (une vérification)
          python tgvmax_alerte.py --test    (envoie une notif de test)
          python tgvmax_alerte.py --liste   (affiche toutes les places dispo, sans notifier)
          python tgvmax_alerte.py --tableau (ouvre le calendrier / les probabilités)
"""

import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser
from datetime import date
from pathlib import Path

import tableau_de_bord

# ======================= CONFIGURATION =======================

# Trajets surveillés : (code gare départ, code gare arrivée)
#   FRXAT = Antibes, FRPLY = Paris (toutes gares intramuros)
ALLER = ("FRXAT", "FRPLY")   # Antibes -> Paris
RETOUR = ("FRPLY", "FRXAT")  # Paris -> Antibes
TRAJETS = [ALLER, RETOUR]

# Aller-retour : nombre de jours entre l'aller et le retour
#   0 = retour le jour même (au moins 1 h après l'arrivée)
SEJOUR_MIN_JOURS = 1
SEJOUR_MAX_JOURS = 7

# Notification sur le téléphone via ntfy (gratuit, sans compte) :
#   1. Installe l'appli "ntfy" (Android / iPhone)
#   2. Abonne-toi au sujet (garde-le secret, n'importe qui connaissant
#      le nom peut lire les messages)
#   Le sujet n'est pas écrit ici pour ne pas être publié sur GitHub :
#   il est lu dans la variable d'environnement NTFY_TOPIC (secret GitHub)
#   ou, sur le PC, dans le fichier ntfy_sujet.txt.
_fichier_sujet = Path(__file__).resolve().parent / "ntfy_sujet.txt"
NTFY_TOPIC = (os.environ.get("NTFY_TOPIC")
              or (_fichier_sujet.read_text().strip() if _fichier_sujet.exists() else None))

# Notification Windows (bulle en bas à droite)
NOTIF_WINDOWS = True

# Filtres optionnels (None = pas de filtre)
DATES_VOULUES = None          # ex : ["2026-11-07", "2026-11-08"]
HEURE_MIN = None              # ex : "07:00" (heure de départ min)
HEURE_MAX = None              # ex : "20:00" (heure de départ max)

# =============================================================

API = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax"
DOSSIER = Path(__file__).resolve().parent
FICHIER_ETAT = DOSSIER / "deja_vus.json"
FICHIER_HISTORIQUE = DOSSIER / "historique.json"
NOMS = {"FRXAT": "Antibes", "FRPLY": "Paris"}
JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]

if sys.stdout:  # évite les erreurs d'accents dans la console Windows
    sys.stdout.reconfigure(encoding="utf-8")


def lire_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def date_mise_a_jour():
    """Date de la dernière mise à jour du dataset par la SNCF."""
    return lire_json(API)["metas"]["default"]["data_processed"]


def recuperer_trains(origine, destination):
    """Renvoie tous les trains du trajet (avec ou sans place TGV Max)."""
    where = (f'origine_iata="{origine}" and destination_iata="{destination}" '
             f'and date>="{date.today().isoformat()}"')
    resultats, offset = [], 0
    while True:
        params = urllib.parse.urlencode({
            "where": where, "order_by": "date, heure_depart",
            "limit": 100, "offset": offset,
        })
        data = lire_json(f"{API}/records?{params}")
        resultats += data["results"]
        offset += 100
        if offset >= data["total_count"]:
            return resultats


def garder(train):
    if DATES_VOULUES and train["date"] not in DATES_VOULUES:
        return False
    if HEURE_MIN and train["heure_depart"] < HEURE_MIN:
        return False
    if HEURE_MAX and train["heure_depart"] > HEURE_MAX:
        return False
    return True


def sens(train):
    return (train["origine_iata"], train["destination_iata"])


def cle(train):
    return f'{train["date"]}|{train["train_no"]}|{train["origine_iata"]}|{train["destination_iata"]}'


def minutes(heure):
    h, m = heure.split(":")
    return int(h) * 60 + int(m)


def allers_retours(dispo):
    """Toutes les combinaisons aller + retour compatibles avec la durée de séjour."""
    allers = [t for t in dispo if sens(t) == ALLER]
    retours = [t for t in dispo if sens(t) == RETOUR]
    combos = []
    for a in allers:
        for r in retours:
            ecart = (date.fromisoformat(r["date"]) - date.fromisoformat(a["date"])).days
            if not SEJOUR_MIN_JOURS <= ecart <= SEJOUR_MAX_JOURS:
                continue
            if ecart == 0 and minutes(r["heure_depart"]) < minutes(a["heure_arrivee"]) + 60:
                continue
            combos.append((a, r))
    return combos


def jour_court(iso):
    d = date.fromisoformat(iso)
    return f'{JOURS[d.weekday()]} {d.strftime("%d/%m")}'


def decrire(train):
    o, d = sens(train)
    return (f'{NOMS.get(o, train["origine"])} → {NOMS.get(d, train["destination"])} '
            f'{jour_court(train["date"])} {train["heure_depart"]}-{train["heure_arrivee"]} '
            f'(train {train["train_no"]})')


def decrire_ar(a, r):
    return (f'Aller {jour_court(a["date"])} {a["heure_depart"]} · '
            f'Retour {jour_court(r["date"])} {r["heure_depart"]}')


def notifier(titre, message, prioritaire=False):
    print(f"\n[NOTIF] {titre}\n{message}\n")
    if NTFY_TOPIC:
        try:
            req = urllib.request.Request(
                f"https://ntfy.sh/{NTFY_TOPIC}", data=message.encode("utf-8"),
                headers={"Title": titre.encode("utf-8"),
                         "Tags": "tada,train" if prioritaire else "train",
                         "Priority": "high" if prioritaire else "default",
                         "Click": "https://www.sncf-connect.com/"})
            urllib.request.urlopen(req, timeout=15)
        except Exception as e:
            print(f"Erreur ntfy : {e}")
    if NOTIF_WINDOWS and sys.platform == "win32":
        notif_windows(titre, message)


def notif_windows(titre, message):
    def xml(s):
        return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                 .replace("'", "''"))
    script = f"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>{xml(titre)}</text><text>{xml(message)}</text></binding></visual></toast>')
$app = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", script],
                   capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def lire_historique():
    if FICHIER_HISTORIQUE.exists():
        return json.loads(FICHIER_HISTORIQUE.read_text(encoding="utf-8"))
    return {"snapshots": [], "trains": {}}


def maj_historique(trains, mise_a_jour):
    """Ajoute la photo du jour (une seule fois par mise à jour SNCF)."""
    h = lire_historique()
    if mise_a_jour in h["snapshots"]:
        return h
    i = len(h["snapshots"])
    h["snapshots"].append(mise_a_jour)
    photo = {}
    for t in trains:
        o, d = sens(t)
        k = f'{t["date"]}|{o}>{d}|{t["train_no"]}'
        libre = 1 if t["od_happy_card"] == "OUI" else 0
        avant = photo.get(k)
        photo[k] = (t, max(libre, avant[1] if avant else 0))
    for k, (t, libre) in photo.items():
        e = h["trains"].setdefault(k, {"dep": t["heure_depart"], "arr": t["heure_arrivee"], "obs": []})
        e["obs"].append([i, libre])
    FICHIER_HISTORIQUE.write_text(json.dumps(h, separators=(",", ":")), encoding="utf-8")
    return h


def notifier_nouveautes(dispo, combos):
    deja_vus = (set(json.loads(FICHIER_ETAT.read_text())) if FICHIER_ETAT.exists() else set())
    cles_combos = {f"AR:{cle(a)}>{cle(r)}": (a, r) for a, r in combos}

    # Alerte spéciale : nouvel aller-retour possible
    nouveaux_ar = [ar for k, ar in cles_combos.items() if k not in deja_vus]
    if nouveaux_ar:
        lignes = [decrire_ar(a, r) for a, r in nouveaux_ar[:8]]
        if len(nouveaux_ar) > 8:
            lignes.append(f"... et {len(nouveaux_ar) - 8} autre(s)")
        notifier(f"🎉 ALLER-RETOUR TGV Max possible ! ({len(nouveaux_ar)})",
                 "\n".join(lignes), prioritaire=True)

    # Une notification par sens, pour qu'un sens ne cache pas l'autre
    nouveaux = [t for t in dispo if cle(t) not in deja_vus]
    for origine, destination in TRAJETS:
        du_sens = [t for t in nouveaux if sens(t) == (origine, destination)]
        if not du_sens:
            continue
        lignes = [decrire(t) for t in du_sens[:10]]
        if len(du_sens) > 10:
            lignes.append(f"... et {len(du_sens) - 10} autre(s)")
        notifier(f"🚄 {NOMS[origine]} → {NOMS[destination]} : "
                 f"{len(du_sens)} nouvelle(s) place(s) TGV Max", "\n".join(lignes))
    if not nouveaux and not nouveaux_ar:
        print("Aucune nouvelle place.")

    # On mémorise ce qui est dispo maintenant : si une place disparaît puis
    # réapparaît plus tard, on sera de nouveau prévenu.
    FICHIER_ETAT.write_text(json.dumps(sorted({cle(t) for t in dispo} | set(cles_combos)), indent=1))


def main():
    if "--test" in sys.argv:
        notifier("TGV Max – test", "Les notifications fonctionnent 🎉")
        return

    trains = []
    for origine, destination in TRAJETS:
        trains += recuperer_trains(origine, destination)
    # L'historique est tenu par GitHub Actions : en mode --tableau / --liste
    # on le lit seulement, pour ne pas créer de conflit avec la version en ligne.
    if "--tableau" in sys.argv or "--liste" in sys.argv:
        historique = lire_historique()
    else:
        historique = maj_historique(trains, date_mise_a_jour())

    dispo = [t for t in trains if t["od_happy_card"] == "OUI" and garder(t)]
    combos = allers_retours(dispo)

    if "--liste" in sys.argv:
        print(f"{len(dispo)} place(s) TGV Max disponible(s) :")
        for t in dispo:
            print("  " + decrire(t))
        print(f"\n{len(combos)} aller(s)-retour(s) possible(s) :")
        for a, r in combos:
            print("  " + decrire_ar(a, r))
        return

    page = tableau_de_bord.generer(DOSSIER / "tableau_de_bord.html", dispo, combos,
                                   historique, max(t["date"] for t in trains), NOMS)
    if "--tableau" in sys.argv:
        webbrowser.open(page.as_uri())
        return

    notifier_nouveautes(dispo, combos)


if __name__ == "__main__":
    main()
