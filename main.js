'use strict';

const utils = require('@iobroker/adapter-core');
const { DATAPOINTS } = require('./lib/datapoints');
const { NwpmClient, HeatPump, DEFAULT_PORT, TOPIC_ERROR_HISTORY, TOPIC_LOCK_HISTORY, TOPIC_TWIN } = require('./lib/nwpm');

const CATEGORIES = {
    sensors: { en: 'Sensors', de: 'Messwerte' },
    status: { en: 'Status', de: 'Status' },
    io: { en: 'Inputs and outputs', de: 'Ein- und Ausgänge' },
    energy: { en: 'Energy', de: 'Energie' },
    statistics: { en: 'Runtimes and starts', de: 'Laufzeiten und Starts' },
    settings: { en: 'Settings', de: 'Einstellungen' },
    control: { en: 'Control', de: 'Steuerung' },
};

// Device twin meta fields shown under info.*
const TWIN_INFO = {
    applianceSerial: ['serial', { en: 'Heat pump serial number', de: 'Seriennummer Wärmepumpe' }, 'string'],
    applianceType: ['applianceType', { en: 'Heat pump type', de: 'Wärmepumpentyp' }, 'string'],
    applianceVersion: ['softwareVersion', { en: 'WPM software version', de: 'WPM-Softwareversion' }, 'string'],
    wpmType: ['wpmType', { en: 'Heat pump manager type', de: 'Wärmepumpenmanager-Typ' }, 'string'],
    gatewaySerial: ['gatewaySerial', { en: 'Gateway serial number', de: 'Seriennummer Gateway' }, 'string'],
    gatewayBoardModel: ['gatewayModel', { en: 'Gateway model', de: 'Gateway-Modell' }, 'string'],
    firmwareVersion: ['gatewayFirmware', { en: 'Gateway firmware', de: 'Gateway-Firmware' }, 'string'],
    applianceConnectionState: ['applianceConnected', { en: 'Heat pump connected to gateway', de: 'Wärmepumpe mit Gateway verbunden' }, 'boolean'],
    cloudConnectionState: ['cloudConnected', { en: 'Cloud connected', de: 'Cloud verbunden' }, 'boolean'],
    internetConnectionState: ['internetConnected', { en: 'Internet connected', de: 'Internet verbunden' }, 'boolean'],
};

class DimplexNwpm extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'dimplex-nwpm' });
        this.client = null;
        this.heatPump = null;
        this.pollTimer = null;
        this.polling = false;
        this.created = new Set();
        this.written = new Map();
        this.language = 'de';

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        // Left over from 0.2.x (password reset button).
        for (const id of ['control.resetPassword', 'info.lastResetResult']) {
            await this.delObjectAsync(id).catch(() => {});
        }
        const host = (this.config.host || '').trim();
        if (!host || !this.config.password) {
            this.log.error('Please configure the IP address and the gateway password');
            return;
        }
        try {
            const sys = await this.getForeignObjectAsync('system.config');
            if (sys && sys.common && sys.common.language) {
                this.language = sys.common.language;
            }
        } catch {
            // keep default
        }

        const username = (this.config.username || '').trim() || 'mqtt';
        this.client = new NwpmClient({
            host,
            username,
            password: String(this.config.password).trim(),
            port: Number(this.config.port) || DEFAULT_PORT,
            connect: this.mqttConnect,
        });
        this.heatPump = new HeatPump(this.client, this.log);

        this.client.on('connect', () => {
            this.log.info(`Connected to Dimplex gateway ${host}`);
            this.lastError = null;
            this.setState('info.connection', true, true);
            this.poll();
        });
        this.client.on('close', () => {
            if (this.written.get('info.connection') !== false) {
                this.log.info('Connection to Dimplex gateway lost, reconnecting');
            }
            this.written.set('info.connection', false);
            this.setState('info.connection', false, true);
        });
        this.client.on('authFailed', err => {
            this.log.error(`${err.message}. Check the gateway password (heat pump display: Analytics → Hardware and software → Network → Gateway access)`);
        });
        this.client.on('error', err => {
            // Log each distinct connection problem once as a warning, repeats only in debug.
            const msg = explainError(err, host, Number(this.config.port) || DEFAULT_PORT);
            if (msg !== this.lastError) {
                this.lastError = msg;
                this.log.warn(msg);
            } else {
                this.log.debug(msg);
            }
        });
        this.heatPump.on('update', topic => this.publish(topic).catch(err => this.log.warn(err.message)));

        this.log.info(`Connecting to Dimplex gateway mqtt://${host}:${Number(this.config.port) || DEFAULT_PORT} (user "${username}")`);
        this.client.connect();
        const seconds = Math.max(15, Number(this.config.pollInterval) || 60);
        this.pollTimer = this.setInterval(() => this.poll(), seconds * 1000);
        this.subscribeStates('settings.*');
        this.subscribeStates('control.*');
    }

    async poll() {
        if (this.polling || !this.client.connected) {
            return;
        }
        this.polling = true;
        try {
            await this.heatPump.update();
        } catch (err) {
            this.log.warn(`Polling the heat pump failed: ${err.message}`);
        } finally {
            this.polling = false;
        }
    }

    /** Write all known values; objects are created once the equipment flags are known. */
    async publish(topic) {
        const hp = this.heatPump;
        if (topic === TOPIC_TWIN && hp.twin) {
            for (const [field, [id]] of Object.entries(TWIN_INFO)) {
                const raw = hp.twin.meta[field];
                if (raw !== undefined && raw !== null) {
                    await this.writeState(`info.${id}`, TWIN_INFO[field][2] === 'boolean' ? raw === '1' : String(raw));
                }
            }
        }
        if (topic === TOPIC_ERROR_HISTORY || topic === TOPIC_LOCK_HISTORY) {
            await this.publishHistory();
        }
        if (!hp.conditionsRead) {
            return;
        }
        for (const [key, dp] of Object.entries(DATAPOINTS)) {
            if (!hp.supports(key)) {
                continue;
            }
            const id = `${dp.category}.${key}`;
            await this.ensureObject(id, key, dp);
            await this.writeState(id, hp.value(key));
        }
    }

    async publishHistory() {
        const hp = this.heatPump;
        const fault = hp.errorHistory[0];
        const lock = hp.lockHistory[0];
        if (fault) {
            await this.writeState('info.lastFaultCode', Number(fault.err_value));
            await this.writeState('info.lastFaultTime', fault.time || null);
        }
        if (lock) {
            await this.writeState('info.lastLockCode', Number(lock.lock_value));
            await this.writeState('info.lastLockTime', lock.time || null);
        }
        await this.writeState('info.faultHistory', JSON.stringify(hp.errorHistory));
        await this.writeState('info.lockHistory', JSON.stringify(hp.lockHistory));
    }

    async writeState(id, value) {
        if (this.written.has(id) && this.written.get(id) === value) {
            return;
        }
        this.written.set(id, value);
        await this.setState(id, value, true);
    }

    label(text) {
        return text[this.language] || text.en;
    }

    async ensureObject(id, key, dp) {
        if (this.created.has(id)) {
            return;
        }
        const channel = dp.category;
        if (!this.created.has(channel)) {
            await this.extendObject(channel, { type: 'channel', common: { name: CATEGORIES[channel] }, native: {} });
            this.created.add(channel);
        }
        const common = {
            name: dp.name,
            type: dp.type,
            role: role(dp),
            read: true,
            write: Boolean(dp.writable),
        };
        if (dp.unit) {
            common.unit = dp.unit;
        }
        if (dp.options) {
            common.states = Object.fromEntries(Object.entries(dp.options).map(([code, text]) => [code, this.label(text)]));
        }
        if (dp.writable && dp.min !== undefined) {
            common.min = dp.min;
            common.max = dp.max;
            common.step = dp.step;
        }
        await this.extendObject(id, { type: 'state', common, native: { names: dp.names } });
        this.created.add(id);
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !this.heatPump) {
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        if (local === 'control.syncTime') {
            try {
                await this.heatPump.setTime();
                this.log.info('Heat pump clock synchronised');
            } catch (err) {
                this.log.warn(`Setting the heat pump clock failed: ${err.message}`);
            }
            await this.setState(local, false, true);
            return;
        }
        const key = local.split('.').pop();
        const dp = DATAPOINTS[key];
        if (!dp || !dp.writable) {
            return;
        }
        try {
            await this.heatPump.set(key, state.val);
            this.log.info(`${key} set to ${state.val}`);
        } catch (err) {
            this.log.warn(`Writing ${key} failed: ${err.message}`);
        }
        // Acknowledge with the value the heat pump actually reports.
        this.written.delete(local);
        await this.writeState(local, this.heatPump.value(key));
    }

    async onUnload(callback) {
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
            }
            if (this.client) {
                await this.client.disconnect();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

function explainError(err, host, port) {
    const hints = {
        ECONNREFUSED: `${host} refuses connections on port ${port}. Is "Network → Home App" enabled on the heat pump and the port correct?`,
        ETIMEDOUT: `${host}:${port} does not answer. Check the IP address and that ioBroker can reach the heat pump network.`,
        EHOSTUNREACH: `${host} is not reachable. Check the IP address.`,
        ENOTFOUND: `Host name ${host} cannot be resolved. Use the IP address.`,
        ECONNRESET: `${host} closed the connection. Too many MQTT clients connected to the gateway, or wrong protocol?`,
    };
    return `MQTT connection problem: ${hints[err.code] || err.message}${err.code && hints[err.code] ? ` (${err.code})` : ''}`;
}

function role(dp) {
    if (dp.type === 'boolean') {
        return 'indicator';
    }
    const prefix = dp.writable ? 'level' : 'value';
    switch (dp.unit) {
        case '°C':
            return `${prefix}.temperature`;
        case 'kWh':
            return 'value.energy';
        case 'W':
            return dp.writable ? 'level' : 'value.power';
        case 'bar':
            return 'value.pressure';
        case '%':
            return dp.name.en.includes('humidity') ? 'value.humidity' : prefix;
        default:
            return dp.options && dp.writable ? 'level.mode' : prefix;
    }
}

if (require.main !== module) {
    module.exports = options => new DimplexNwpm(options);
} else {
    new DimplexNwpm();
}
