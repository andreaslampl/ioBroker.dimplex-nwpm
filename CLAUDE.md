# ioBroker.dimplex-nwpm

ioBroker adapter for Dimplex heat pumps with System M / NWPM Touch. Talks to the
gateway's built-in MQTT v5 broker (port 61894, user `mqtt`, password from the
Dimplex Home app / display). No cloud.

## Layout

- `main.js` – adapter: config, object creation, state writes, writes from ioBroker.
- `lib/nwpm.js` – protocol: `NwpmClient` (MQTT v5 request/response with response
  topic + correlation data), `HeatPump` (value store, push merge, polling, scaling).
- `lib/datapoints.js` – generated table of ~177 datapoints. Do not edit by hand;
  regenerate with `tools/generate-datapoints.py` (see header of that file).
- `test/` – `node --test`; `adapter.test.js` stubs `@iobroker/adapter-core`,
  `wire.test.js` runs the real mqtt.js against a minimal MQTT v5 server.

## Protocol notes

- Requests: `gateway/modbus/get_value/<name>` `{"name": "1300-1302u"}`,
  `gateway/modbus/set_value/<name>` `{"name": "1042u", "value": ["50"]}`.
  Names: index + `d` (digital), `i`/`u` (16 bit, same variable), `a` (analog).
- Push: `gateway/broadcast/changed_on/modbus/#`, `extern/broadcast/twin_reported_state`,
  fault/lock history, appliance time.
- Composite energy counters (3 parts) are only taken from polls, never from push.
- Based on pydimplex-nwpm / hass-dimplex-nwpm by patr_ (MIT).

## History / field experience

- Tested on the owner's System M at 10.0.0.22. A "Not authorized" error turned out
  to be a swapped SD card in the heat pump (other gateway, other password).
- The documented reset port 61890 never opened on this System M, so the reset
  button was removed again in 0.3.0.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.dimplex-nwpm`.
- Run `npm test` before committing.
