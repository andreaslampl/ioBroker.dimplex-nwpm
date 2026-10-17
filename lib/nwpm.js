'use strict';

/*
 * Dimplex NWPM Touch gateway (built into System M heat pumps).
 *
 * The gateway runs a local MQTT v5 broker (port 61894, user "mqtt"). Values
 * are addressed by pCO variable index and a type suffix: d (digital),
 * i/u (signed/unsigned 16 bit, same variable) and a (analog, already scaled).
 * Requests use MQTT v5 response topic + correlation data:
 *
 *   gateway/modbus/get_value/<name>   {"name": "1300-1302u"}
 *   gateway/modbus/set_value/<name>   {"name": "1042u", "value": ["50"]}
 *
 * The gateway pushes changed values, its device twin and the fault/lock
 * history on broadcast topics.
 *
 * Protocol details are ported from pydimplex-nwpm by patr_ (MIT license,
 * https://github.com/p-atr/pydimplex-nwpm).
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { POLL_RANGES, CONDITION_RANGES, DATAPOINTS } = require('./datapoints');

const DEFAULT_PORT = 61894;
const USERNAME = 'mqtt';
const REQUEST_TIMEOUT = 10000;
const MAX_POLL_TIMEOUTS = 3;
// MQTT v5 CONNACK reason codes for wrong credentials.
const AUTH_FAILURE_CODES = new Set([134, 135]);

const TOPIC_CHANGED = 'gateway/broadcast/changed_on/modbus';
const TOPIC_TWIN = 'extern/broadcast/twin_reported_state';
const TOPIC_ERROR_HISTORY = 'extern/broadcast/error_history_state';
const TOPIC_LOCK_HISTORY = 'extern/broadcast/lock_history_state';
const TOPIC_APPLIANCE_TIME = 'extern/broadcast/appliance_time_state';
const BROADCAST_TOPICS = [`${TOPIC_CHANGED}/#`, TOPIC_TWIN, TOPIC_ERROR_HISTORY, TOPIC_LOCK_HISTORY, TOPIC_APPLIANCE_TIME];

class DimplexError extends Error {}
class DimplexTimeoutError extends DimplexError {}
class DimplexConnectionError extends DimplexError {}
class DimplexAuthenticationError extends DimplexConnectionError {}
class DimplexRequestError extends DimplexError {
    constructor(status, message) {
        super(`Gateway returned status ${status}: ${message}`);
        this.status = status;
    }
}

const NAME_RE = /^(\d+)(?:-(\d+))?([adiu])$/;

function splitName(name) {
    const m = NAME_RE.exec(name);
    if (!m) {
        throw new RangeError(`Invalid datapoint name: ${name}`);
    }
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (end < start) {
        throw new RangeError(`Invalid datapoint range: ${name}`);
    }
    return [start, end, m[3]];
}

/** "1300-1302u" -> ["1300u", "1301u", "1302u"] */
function expandRange(name) {
    const [start, end, kind] = splitName(name);
    const out = [];
    for (let i = start; i <= end; i++) {
        out.push(`${i}${kind}`);
    }
    return out;
}

/** Single datapoint name with "u" normalised to "i". */
function canonicalName(name) {
    const [start, end, kind] = splitName(name);
    if (start !== end) {
        throw new RangeError(`Expected a single datapoint, got range: ${name}`);
    }
    return `${start}${kind === 'u' ? 'i' : kind}`;
}

function parseValue(name, raw) {
    const kind = name[name.length - 1];
    if (kind === 'd') {
        return typeof raw === 'string' ? ['1', 'true'].includes(raw.trim().toLowerCase()) : Boolean(raw);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new RangeError(`Invalid value for ${name}: ${raw}`);
    }
    // Analog-looking strings occasionally show up for integer datapoints.
    return kind === 'a' ? n : Math.trunc(n);
}

function formatValue(name, value) {
    const kind = name[name.length - 1];
    if (kind === 'd') {
        return value ? '1' : '0';
    }
    if (kind === 'a') {
        return Number(value).toFixed(1);
    }
    return String(Math.round(value));
}

// Push updates may deliver parts of a composite energy counter separately,
// which would briefly produce a wrong total; they are only taken from polls.
const COMPOSITE_PARTS = new Set(
    Object.values(DATAPOINTS)
        .filter(dp => dp.keys.length > 1)
        .flatMap(dp => dp.keys),
);

/**
 * MQTT v5 connection to the gateway with request/response helpers.
 *
 * Events: 'connect', 'close', 'message' (topic, parsed payload),
 * 'authFailed', 'error'.
 */
class NwpmClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host
     * @param {string} options.password
     * @param {number} [options.port]
     * @param {(url: string, opts: object) => any} [options.connect] mqtt.connect (injectable for tests)
     */
    constructor({ host, password, username = USERNAME, port = DEFAULT_PORT, connect, timeout = REQUEST_TIMEOUT }) {
        super();
        this.host = host;
        this.port = port;
        this.password = password;
        this.username = username;
        this.timeout = timeout;
        this.mqttConnect = connect || require('mqtt').connect;
        this.clientId = `iobroker_${crypto.randomBytes(4).toString('hex')}`;
        this.replyRoot = `extern/${this.clientId}`;
        this.pending = new Map();
        this.correlation = 0;
        this.connected = false;
        this.client = null;
    }

    connect() {
        this.client = this.mqttConnect(`mqtt://${this.host}:${this.port}`, {
            protocolVersion: 5,
            username: this.username,
            password: this.password,
            clientId: this.clientId,
            keepalive: 30,
            reconnectPeriod: 5000,
            connectTimeout: this.timeout,
            clean: true,
        });
        this.client.on('connect', () => {
            this.client.subscribe([`${this.replyRoot}/#`, ...BROADCAST_TOPICS], { qos: 0 }, err => {
                if (err) {
                    this.emit('error', new DimplexConnectionError(`Subscribing failed: ${err.message}`));
                    return;
                }
                this._setConnected(true);
            });
        });
        this.client.on('close', () => this._setConnected(false));
        this.client.on('disconnect', packet => {
            const code = packet && packet.reasonCode;
            this.emit('error', new DimplexConnectionError(`Gateway disconnected us (reason code ${code})`));
        });
        this.client.on('error', err => {
            if (AUTH_FAILURE_CODES.has(err.code)) {
                // Retrying with the same password is pointless.
                this.client.end(true);
                this.emit('authFailed', new DimplexAuthenticationError(`Gateway rejected the credentials: ${err.message}`));
                return;
            }
            this.emit('error', err);
        });
        this.client.on('message', (topic, payload, packet) => this._handle(topic, payload, packet));
    }

    disconnect() {
        return new Promise(resolve => {
            if (!this.client) {
                resolve();
                return;
            }
            this.client.end(true, {}, () => resolve());
            this._setConnected(false);
        });
    }

    _setConnected(connected) {
        if (this.connected === connected) {
            return;
        }
        this.connected = connected;
        if (!connected) {
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new DimplexConnectionError('Connection lost'));
            }
            this.pending.clear();
        }
        this.emit(connected ? 'connect' : 'close');
    }

    _handle(topic, payload, packet) {
        let data;
        try {
            data = JSON.parse(payload.toString());
        } catch {
            this.emit('error', new DimplexError(`Unable to parse message on ${topic}`));
            return;
        }
        if (!topic.startsWith(this.replyRoot)) {
            this.emit('message', topic, data);
            return;
        }
        let correlation = packet && packet.properties && packet.properties.correlationData;
        if (correlation) {
            correlation = Buffer.from(correlation).readUInt32BE(0);
        } else if (data && data.mqtt_msg_properties) {
            correlation = Number(data.mqtt_msg_properties.correlation_data);
        }
        const p = this.pending.get(correlation);
        if (p) {
            this.pending.delete(correlation);
            clearTimeout(p.timer);
            p.resolve(data);
        }
    }

    async _request(topic, reply, payload) {
        if (!this.connected) {
            throw new DimplexConnectionError('Not connected to the gateway');
        }
        this.correlation = (this.correlation + 1) >>> 0;
        const correlation = this.correlation;
        const correlationData = Buffer.alloc(4);
        correlationData.writeUInt32BE(correlation, 0);
        const response = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(correlation);
                reject(new DimplexTimeoutError(`No response from gateway for ${topic}`));
            }, this.timeout);
            this.pending.set(correlation, { resolve, reject, timer });
            this.client.publish(
                topic,
                JSON.stringify(payload),
                { qos: 0, properties: { responseTopic: `${this.replyRoot}/${reply}`, correlationData } },
                err => {
                    if (err) {
                        clearTimeout(timer);
                        this.pending.delete(correlation);
                        reject(new DimplexConnectionError(`Publishing to ${topic} failed: ${err.message}`));
                    }
                },
            );
        });
        const status = Number(response.status || 0);
        if (status) {
            throw new DimplexRequestError(status, String(response.error_message || ''));
        }
        return response;
    }

    /** Read a datapoint or range; returns { canonicalName: value }. */
    async getValues(name) {
        const names = expandRange(name);
        const response = await this._request(`gateway/modbus/get_value/${name}`, `get_value_reply/${name}`, { name });
        const raw = (response.content && response.content.value) || [];
        if (raw.length !== names.length) {
            throw new DimplexRequestError(-1, `Gateway returned ${raw.length} values for ${name}`);
        }
        const out = {};
        names.forEach((single, i) => {
            out[canonicalName(single)] = parseValue(single, raw[i]);
        });
        return out;
    }

    /** Write a single datapoint (raw, unscaled value). */
    async setValue(name, value) {
        await this._request(`gateway/modbus/set_value/${name}`, `set_value_reply/${name}`, {
            name,
            value: [formatValue(name, value)],
        });
    }

    /** Set the naive local clock of the appliance ("YYYY-MM-DDTHH:MM:SS"). */
    async setApplianceTime(isoLocal) {
        await this._request('gateway/modbus/set_value/appliance_time_set', 'set_value_reply/appliance_time_set', {
            name: 'appliance_time_set',
            value: isoLocal,
        });
    }
}

/**
 * Heat pump manager behind the gateway: raw value store, push merging,
 * polling and scaled datapoint access.
 *
 * Events: 'update' (after push messages, polls and writes).
 */
class HeatPump extends EventEmitter {
    constructor(client, log) {
        super();
        this.client = client;
        this.log = log;
        this.values = {};
        this.twin = null;
        this.errorHistory = [];
        this.lockHistory = [];
        this.utcOffsetMinutes = null;
        this.conditionsRead = false;
        client.on('message', (topic, payload) => this._handleMessage(topic, payload));
    }

    /** Equipment flags unknown to the software version count as installed. */
    has(flag) {
        return flag in this.values ? Boolean(this.values[flag]) : true;
    }

    supports(key) {
        const dp = DATAPOINTS[key];
        return !dp.requires || this.has(dp.requires);
    }

    available(key) {
        return DATAPOINTS[key].keys.every(k => k in this.values);
    }

    /** Scaled value, option code or counter total; null while unknown. */
    value(key) {
        const dp = DATAPOINTS[key];
        if (!this.available(key)) {
            return null;
        }
        const raw = dp.keys.map(k => this.values[k]);
        if (raw.length === 3) {
            const [low, mid, high] = raw.map(Number);
            return high * 100000000 + mid * 10000 + low;
        }
        const v = raw[0];
        if (typeof v === 'boolean' || dp.options) {
            return v;
        }
        const scale = dp.scale || 1;
        const offset = dp.offset || 0;
        if (scale === 1 && !offset) {
            return v;
        }
        return Math.round((v * scale + offset) * 100) / 100;
    }

    async update() {
        if (!this.conditionsRead) {
            await this._poll(CONDITION_RANGES);
            this.conditionsRead = true;
        }
        await this._poll(POLL_RANGES);
        this.emit('update');
    }

    /** Write a setting (scaled value or option code) and read it back. */
    async set(key, value) {
        const dp = DATAPOINTS[key];
        if (!dp || !dp.writable) {
            throw new RangeError(`${key} is not writable`);
        }
        let raw;
        if (dp.options) {
            if (!(String(value) in dp.options)) {
                throw new RangeError(`Invalid option for ${key}: ${value}`);
            }
            raw = Number(value);
        } else {
            const v = Number(value);
            if (!Number.isFinite(v) || v < dp.min || v > dp.max) {
                throw new RangeError(`Invalid value for ${key}: ${value} (allowed ${dp.min} … ${dp.max})`);
            }
            raw = (v - (dp.offset || 0)) / (dp.scale || 1);
        }
        const name = dp.names[0];
        await this.client.setValue(name, raw);
        Object.assign(this.values, await this.client.getValues(name));
        this.emit('update');
    }

    /** Set the appliance clock; uses the gateway's UTC offset if it reported one. */
    async setTime(now = new Date()) {
        const offset = this.utcOffsetMinutes !== null ? this.utcOffsetMinutes : -now.getTimezoneOffset();
        const local = new Date(now.getTime() + offset * 60000);
        await this.client.setApplianceTime(local.toISOString().slice(0, 19));
    }

    async _poll(ranges) {
        let timeouts = 0;
        for (const name of ranges) {
            try {
                Object.assign(this.values, await this.client.getValues(name));
            } catch (err) {
                if (err instanceof DimplexRequestError) {
                    this.log.debug(`Datapoint range ${name} not available: ${err.message}`);
                } else if (err instanceof DimplexTimeoutError) {
                    timeouts++;
                    if (timeouts >= MAX_POLL_TIMEOUTS) {
                        throw err;
                    }
                    this.log.debug(`Datapoint range ${name} timed out`);
                } else {
                    throw err;
                }
            }
        }
    }

    _handleMessage(topic, payload) {
        if (topic.startsWith(TOPIC_CHANGED)) {
            for (const batch of Object.values(payload || {})) {
                const raw = {};
                for (const [name, item] of Object.entries((batch && batch.value_batch) || {})) {
                    raw[name] = item && item.value;
                }
                this._merge(raw);
            }
        } else if (topic === TOPIC_TWIN) {
            this.twin = { meta: payload.meta || {}, telemetry: payload.telemetry || {} };
            this._merge(this.twin.telemetry);
        } else if (topic === TOPIC_ERROR_HISTORY) {
            this.errorHistory = Array.isArray(payload) ? payload : [];
        } else if (topic === TOPIC_LOCK_HISTORY) {
            this.lockHistory = Array.isArray(payload) ? payload : [];
        } else if (topic === TOPIC_APPLIANCE_TIME) {
            const offset = payload && payload.utc_offset_minutes;
            this.utcOffsetMinutes = offset === null || offset === undefined ? null : Number(offset);
        } else {
            return;
        }
        this.emit('update', topic);
    }

    _merge(raw) {
        for (const [name, value] of Object.entries(raw)) {
            if (value === null || value === undefined) {
                continue;
            }
            let key;
            let parsed;
            try {
                key = canonicalName(name);
                parsed = parseValue(name, value);
            } catch {
                continue;
            }
            if (!COMPOSITE_PARTS.has(key)) {
                this.values[key] = parsed;
            }
        }
    }
}

module.exports = {
    DEFAULT_PORT,
    TOPIC_CHANGED,
    TOPIC_TWIN,
    TOPIC_ERROR_HISTORY,
    TOPIC_LOCK_HISTORY,
    TOPIC_APPLIANCE_TIME,
    DimplexError,
    DimplexTimeoutError,
    DimplexConnectionError,
    DimplexAuthenticationError,
    DimplexRequestError,
    expandRange,
    canonicalName,
    parseValue,
    formatValue,
    NwpmClient,
    HeatPump,
};
