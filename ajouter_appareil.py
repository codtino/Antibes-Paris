"""
Ajoute un appareil aux notifications web.
Usage :  python ajouter_appareil.py '<code d'activation copié depuis le site>'

Vérifie le code, l'ajoute à webpush_abonnements.json (jamais publié),
met à jour le secret GitHub WEB_PUSH_ABONNEMENTS et envoie une notif de test.
"""

import base64
import json
import re
import subprocess
import sys

import tgvmax_alerte as t

REPO = "codtino/Antibes-Paris"


def nettoyer(texte):
    # L'iPhone remplace parfois les guillemets par des « » ou des “ ”
    for c in "«»“”„":
        texte = texte.replace(c, '"')
    return re.sub(r'"\s+|\s+"', '"', texte.strip())


def verifier(abo):
    dec = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    p, a = dec(abo["keys"]["p256dh"]), dec(abo["keys"]["auth"])
    assert abo["endpoint"].startswith("https://"), "endpoint invalide"
    assert len(p) == 65 and p[0] == 4, "clé p256dh invalide"
    assert len(a) == 16, "clé auth invalide"


def main():
    abo = json.loads(nettoyer(sys.argv[1]))
    verifier(abo)
    fichier = t.DOSSIER / "webpush_abonnements.json"
    abos = json.loads(fichier.read_text()) if fichier.exists() else []
    abos = [x for x in abos if x["endpoint"] != abo["endpoint"]] + [abo]
    contenu = json.dumps(abos, separators=(",", ":"))
    fichier.write_text(contenu + "\n")
    subprocess.run(["gh", "secret", "set", "WEB_PUSH_ABONNEMENTS", "--repo", REPO],
                   input=contenu, text=True, check=True)
    print(f"{len(abos)} appareil(s) abonné(s), secret GitHub mis à jour")

    from pywebpush import webpush
    r = webpush(subscription_info=abo,
                data=json.dumps({"title": "TGV Max – test 🎉",
                                 "body": "Cet appareil recevra les alertes TGV Max.",
                                 "url": t.SITE}),
                vapid_private_key=(t.DOSSIER / "vapid_prive.txt").read_text().strip(),
                vapid_claims={"sub": t.CONTACT_VAPID}, ttl=3600)
    print(f"Notification de test envoyée (réponse {r.status_code})")


if __name__ == "__main__":
    main()
