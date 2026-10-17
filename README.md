# ioBroker.dimplex-nwpm

ioBroker-Adapter für **Dimplex Wärmepumpen** mit **System M** oder der Netzwerkerweiterung
**NWPM Touch**. Die Verbindung läuft **lokal** über den MQTT-Broker, der im Gateway der
Wärmepumpe eingebaut ist, also ohne Dimplex-Cloud und ohne eigenen MQTT-Broker.

- Rund 170 Werte: Temperaturen, Status, Sperren und Störungen, Ein- und Ausgänge (Verdichter, Pumpen, Heizstab …),
  Wärmemengen, Leistung, Laufzeiten und Starts
- Aktuelle Werte kommen **sofort** (Push), Einstellungen und Zähler werden regelmäßig abgefragt
- **Steuern:** Betriebsmodus, Smart Grid / SG-Ready, Sperre extern, Warmwasser-Solltemperatur,
  Heizkurve, Party/Urlaub, Raumsolltemperatur, PV-Überschuss, externe Außentemperatur u. v. m.
- Es werden nur Datenpunkte angelegt, die an deiner Anlage auch vorhanden sind
  (Pool, Solar, 2./3. Heizkreis, Lüftung …)

Protokoll und Datenpunkttabelle basieren auf [pydimplex-nwpm](https://github.com/p-atr/pydimplex-nwpm)
und [hass-dimplex-nwpm](https://github.com/p-atr/hass-dimplex-nwpm) von patr_ (MIT).
Siehe auch das [Dimplex Wiki: MQTT Anbindung](https://dimplex.atlassian.net/wiki/spaces/DW/pages/3021930597/MQTT+Anbindung).

## Voraussetzungen

- Dimplex **System M** oder Wärmepumpenmanager mit Touch-Display und **NWPM Touch**
  (WPM-Software M3.3 oder neuer)
- Im Display der Wärmepumpe: **Einstellungen → Netzwerk** auf **Home App** stellen,
  damit das Gateway aktiv ist
- Das **Gateway-Passwort**: im Display unter **Analyse → Hard- und Software → Netzwerk →
  Gateway-Zugang** oder in der Dimplex Home App unter *Servicedaten*

## Installation

Im ioBroker-Admin unter **Adapter** das GitHub-Symbol (*Installieren aus eigener URL*) →
Reiter **Benutzerdefiniert**:

```
https://github.com/andreaslampl/ioBroker.dimplex-nwpm
```

oder auf der Konsole:

```bash
iobroker url https://github.com/andreaslampl/ioBroker.dimplex-nwpm
iobroker add dimplex-nwpm
```

## Konfiguration

| Einstellung | Wert |
| --- | --- |
| IP-Adresse | IP der Wärmepumpe bzw. des Gateways (im Router meist als `pcoweb…` zu finden) |
| MQTT-Port | `61894` (Standard) |
| Gateway-Passwort | siehe oben, Benutzername ist immer `mqtt` |
| Abfrageintervall | 60 s (Einstellungen, Zähler, Laufzeiten) |

## Datenpunkte

| Ordner | Inhalt |
| --- | --- |
| `info.*` | Verbindung, Seriennummer, Software-/Firmwareversion, Cloud-/Internetstatus, letzte Störung/Sperre |
| `sensors.*` | Temperaturen, Drücke, Durchfluss, Inverter, Leistung |
| `status.*` | Status, Sperre, Störung, Sensorstörung, Anforderungen (Werte mit Klartext) |
| `io.*` | Eingänge und Ausgänge (Verdichter, Pumpen, Heizstab, Mischer, EVU-Sperre …) |
| `energy.*` | Wärmemengen in kWh |
| `statistics.*` | Laufzeiten in h und Verdichterstarts |
| `settings.*` | **schreibbar**: Sollwerte, Heizkurve, Hysteresen, Party/Urlaub, PV-Überschuss … |
| `control.*` | **schreibbar**: Betriebsmodus, Smart Grid, Sperre extern, `syncTime` (Uhr stellen) |

Schreibbare Werte werden auf die erlaubten Grenzen geprüft. Nach dem Schreiben liest der Adapter
den Wert zurück und bestätigt ihn erst dann.

**Hinweise**
- Smart Grid setzt der Wärmepumpenmanager nach einem Stromausfall auf *Hardwareeingang* zurück.
- Häufiges Schreiben (z. B. PV-Überschuss) nur in sinnvollen Abständen, z. B. jede Minute.

## Entwicklung

```bash
npm install
npm test
```

Die Datenpunkttabelle `lib/datapoints.js` wird mit `tools/generate-datapoints.py` aus den
Vorlagen erzeugt. Die Tests prüfen Skalierung, Zähler und Schreiblogik mit Messwerten einer echten
Anlage und den Adapter gegen ein simuliertes Gateway, auch auf MQTT-v5-Protokollebene.

## Lizenz

MIT
