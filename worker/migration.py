"""
Génère migration.sql : reprend l'historique (historique.json) et les appareils
abonnés (webpush_abonnements.json) de l'ancienne version dans la base D1.
Usage : python migration.py   puis   npx wrangler d1 execute tgvmax --remote --file migration.sql
"""

import json
from datetime import datetime, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
q = lambda v: "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"

lignes = []
h = json.loads((RACINE / "historique.json").read_text(encoding="utf-8"))
for cle, e in h["trains"].items():
    date, od, train = cle.split("|")
    for i, libre in e["obs"]:
        lignes.append(f"INSERT OR REPLACE INTO obs (snap, od, date, train, dep, arr, libre) VALUES "
                      f"({q(h['snapshots'][i])}, {q(od)}, {q(date)}, {q(train)}, {q(e['dep'])}, {q(e['arr'])}, {libre});")

abonnements = RACINE / "webpush_abonnements.json"
maintenant = datetime.now(timezone.utc).isoformat()
noms = {"fcm.googleapis.com": "Chrome", "web.push.apple.com": "iPhone / iPad"}
if abonnements.exists():
    for i, a in enumerate(json.loads(abonnements.read_text())):
        hote = a["endpoint"].split("/")[2]
        lignes.append(f"INSERT OR IGNORE INTO devices (endpoint, p256dh, auth, label, created) VALUES "
                      f"({q(a['endpoint'])}, {q(a['keys']['p256dh'])}, {q(a['keys']['auth'])}, "
                      f"{q(f'{noms.get(hote, hote)} {i + 1}')}, {q(maintenant)});")

# La dernière publication déjà traitée par l'ancienne version : pas de notification en double
lignes.append(f"INSERT OR REPLACE INTO meta (k, v) VALUES ('snap', {q(h['snapshots'][-1])});")

(Path(__file__).parent / "migration.sql").write_text("\n".join(lignes) + "\n", encoding="utf-8")
print(f"{len(lignes)} instructions, {len(h['snapshots'])} publications")
