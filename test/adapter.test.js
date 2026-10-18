'use strict';

// End-to-end: adapter (stubbed adapter-core) + NwpmClient against a fake
// MQTT v5 gateway that answers get_value/set_value requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const nwpm = require('../lib/nwpm');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.warnings = [];
        this.log = { debug() {}, info() {}, warn: m => this.warnings.push(m), error: m => this.warnings.push(m) };
    }
    async setState(id, val, ack) {
        this.states[id] = { val, ack };
    }
    async extendObject(id, obj) {
        this.objects[id] = obj;
    }
    async getForeignObjectAsync() {
        return { common: { language: 'de' } };
    }
    subscribeStates() {}
    async delObjectAsync(id) {
        delete this.objects[id];
    }
    setInterval(fn, ms) {
        return setInterval(fn, ms);
    }
    clearInterval(t) {
        clearInterval(t);
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};

/** Fake gateway broker speaking the NWPM request/response protocol. */
function fakeGateway(values, { password = 'secret', legacyCorrelation = false } = {}) {
    const gw = { values, requests: [], client: null };
    gw.connect = (url, opts) => {
        const c = new EventEmitter();
        gw.client = c;
        gw.opts = opts;
        c.subscribe = (topics, o, cb) => {
            gw.subscribed = topics;
            cb(null);
        };
        c.end = (force, o, cb) => {
            setImmediate(() => c.emit('close'));
            if (cb) {
                cb();
            }
        };
        c.publish = (topic, message, o, cb) => {
            cb(null);
            const req = JSON.parse(message);
            gw.requests.push([topic, req]);
            let reply;
            if (topic.startsWith('gateway/modbus/get_value/')) {
                const names = nwpm.expandRange(req.name);
                reply = { status: 0, content: { value: names.map(n => String(gw.values[nwpm.canonicalName(n)] ?? 0)) } };
            } else if (topic.startsWith('gateway/modbus/set_value/')) {
                if (req.name !== 'appliance_time_set') {
                    gw.values[nwpm.canonicalName(req.name)] = Number(req.value[0]);
                }
                reply = { status: 0 };
            }
            const corr = o.properties.correlationData;
            const props = legacyCorrelation ? {} : { correlationData: corr };
            if (legacyCorrelation) {
                reply.mqtt_msg_properties = { correlation_data: String(corr.readUInt32BE(0)) };
            }
            setImmediate(() => c.emit('message', o.properties.responseTopic, Buffer.from(JSON.stringify(reply)), { properties: props }));
        };
        setImmediate(() => {
            if (opts.password !== password) {
                const err = new Error('Connection refused: Not authorized');
                err.code = 135;
                c.emit('error', err);
                return;
            }
            c.emit('connect');
        });
        return c;
    };
    gw.push = (topic, payload) => gw.client.emit('message', topic, Buffer.from(JSON.stringify(payload)), {});
    return gw;
}

const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timeout waiting for condition');
        }
        await new Promise(r => setTimeout(r, 10));
    }
};

for (const legacyCorrelation of [false, true]) {
    test(`adapter end-to-end${legacyCorrelation ? ' (correlation in payload)' : ''}`, async () => {
        const gw = fakeGateway({ ...require('./fixtures/values.json') }, { legacyCorrelation });
        const adapter = require('../main.js')({ config: { host: '192.0.2.10', password: 'secret', pollInterval: 60 } });
        adapter.mqttConnect = gw.connect;
        adapter.emit('ready');
        const s = adapter.states;
        test.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
        await until(() => s['sensors.outdoor_temperature']);

        assert.equal(gw.opts.protocolVersion, 5);
        assert.equal(gw.opts.username, 'mqtt');
        assert.ok(gw.subscribed.includes('extern/broadcast/twin_reported_state'));
        assert.equal(s['info.connection'].val, true);
        assert.equal(s['sensors.outdoor_temperature'].val, 13.6);
        assert.equal(adapter.objects['sensors.outdoor_temperature'].common.unit, '°C');
        assert.equal(adapter.objects['sensors.outdoor_temperature'].common.name.de, 'Außentemperatur');
        assert.equal(adapter.objects['control.operating_mode'].common.states['1'], 'Auto');
        assert.equal(adapter.objects['control.operating_mode'].common.write, true);
        assert.equal(adapter.objects['sensors.pool_temperature'], undefined); // no pool installed
        assert.equal(typeof s['io.compressor_1'].val, 'boolean');
        assert.ok(s['energy.heating_energy'].val > 0);

        // Push update
        gw.push('gateway/broadcast/changed_on/modbus/x', { b: { value_batch: { '1301a': { value: '-4.2' } } } });
        await until(() => s['sensors.outdoor_temperature'].val === -4.2);
        gw.push('extern/broadcast/twin_reported_state', {
            meta: { applianceSerial: 'SN123', firmwareVersion: 'A2.1.0', cloudConnectionState: '0' },
            telemetry: {},
        });
        await until(() => s['info.cloudConnected']);
        assert.equal(s['info.serial'].val, 'SN123');
        assert.equal(s['info.cloudConnected'].val, false);

        // Writes
        await adapter.onStateChange(`${adapter.namespace}.settings.hot_water_setpoint`, { val: 52, ack: false });
        assert.equal(gw.values['1042i'], 52);
        assert.deepEqual(s['settings.hot_water_setpoint'], { val: 52, ack: true });

        await adapter.onStateChange(`${adapter.namespace}.control.operating_mode`, { val: 0, ack: false });
        assert.deepEqual(s['control.operating_mode'], { val: 0, ack: true });

        // Out-of-range write is rejected and the state reset to the real value
        await adapter.onStateChange(`${adapter.namespace}.settings.hot_water_setpoint`, { val: 120, ack: false });
        assert.deepEqual(s['settings.hot_water_setpoint'], { val: 52, ack: true });
        assert.match(adapter.warnings.at(-1), /Invalid value/);

        await adapter.onStateChange(`${adapter.namespace}.control.syncTime`, { val: true, ack: false });
        assert.equal(gw.requests.at(-1)[1].name, 'appliance_time_set');

        await new Promise(resolve => adapter.emit('unload', resolve));
        assert.equal(s['info.connection'].val, false);
    });
}

test('wrong password is reported once and not retried', async () => {
    const gw = fakeGateway({}, { password: 'right' });
    const adapter = require('../main.js')({ config: { host: '192.0.2.10', password: 'wrong' } });
    adapter.mqttConnect = gw.connect;
    adapter.emit('ready');
    await until(() => adapter.warnings.length);
    assert.match(adapter.warnings[0], /rejected the credentials/);
    await new Promise(resolve => adapter.emit('unload', resolve));
});

