'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const nwpm = require('../lib/nwpm');
const { DATAPOINTS, POLL_RANGES, CONDITION_RANGES } = require('../lib/datapoints');

test('datapoint name helpers', () => {
    assert.deepEqual(nwpm.expandRange('1300-1302u'), ['1300u', '1301u', '1302u']);
    assert.deepEqual(nwpm.expandRange('1042u'), ['1042u']);
    assert.equal(nwpm.canonicalName('1042u'), '1042i');
    assert.equal(nwpm.canonicalName('1301a'), '1301a');
    assert.throws(() => nwpm.canonicalName('1300-1302u'));
    assert.throws(() => nwpm.expandRange('12x'));
    assert.equal(nwpm.parseValue('1500d', '1'), true);
    assert.equal(nwpm.parseValue('1500d', 'false'), false);
    assert.equal(nwpm.parseValue('1301a', '-3.5'), -3.5);
    assert.equal(nwpm.parseValue('714u', '1.0'), 1);
    assert.equal(nwpm.formatValue('701a', 1.25), '1.3');
    assert.equal(nwpm.formatValue('767u', 21.6), '22');
    assert.equal(nwpm.formatValue('3d', true), '1');
});

test('every polled datapoint is covered by a poll range', () => {
    const polled = new Set(
        [...POLL_RANGES, ...CONDITION_RANGES].flatMap(r => nwpm.expandRange(r).map(nwpm.canonicalName)),
    );
    const missing = Object.entries(DATAPOINTS)
        .filter(([, dp]) => !['sensors', 'io'].includes(dp.category))
        .flatMap(([, dp]) => dp.keys)
        .filter(k => !polled.has(k));
    assert.deepEqual(missing, []);
});

class FakeClient extends EventEmitter {
    constructor(values) {
        super();
        this.values = values;
        this.writes = [];
    }
    async getValues(name) {
        const out = {};
        for (const single of nwpm.expandRange(name)) {
            const key = nwpm.canonicalName(single);
            out[key] = nwpm.parseValue(single, this.values[key] ?? 0);
        }
        return out;
    }
    async setValue(name, raw) {
        this.writes.push([name, nwpm.formatValue(name, raw)]);
        this.values[nwpm.canonicalName(name)] = Number(nwpm.formatValue(name, raw));
    }
    async setApplianceTime(value) {
        this.time = value;
    }
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('heat pump scaling, options, counters and writes', async () => {
    const client = new FakeClient({ ...require('./fixtures/values.json') });
    const hp = new nwpm.HeatPump(client, log);
    await hp.update();
    assert.equal(hp.value('outdoor_temperature'), 13.6);
    assert.equal(typeof hp.value('compressor_1'), 'boolean');
    // 0.1 K steps and 10 W steps
    assert.equal(hp.value('hot_water_temperature_setpoint'), client.values['1594i'] / 10);
    assert.equal(hp.value('thermal_power'), client.values['2666i'] * 10);
    // composite counter: high * 1e8 + mid * 1e4 + low
    const [lo, mid, hi] = ['1300i', '1301i', '1302i'].map(k => client.values[k]);
    assert.equal(hp.value('heating_energy'), hi * 100000000 + mid * 10000 + lo);
    assert.equal(hp.supports('pool_temperature'), false); // 1035d is false in the fixture

    // offset: parallel shift raw = value + 19
    await hp.set('heating_curve_parallel_shift', -2);
    assert.deepEqual(client.writes.at(-1), ['767u', '17']);
    assert.equal(hp.value('heating_curve_parallel_shift'), -2);
    await hp.set('operating_mode', 3);
    assert.deepEqual(client.writes.at(-1), ['714u', '3']);
    await hp.set('pv_surplus', 1230);
    assert.deepEqual(client.writes.at(-1), ['2670i', '123']);
    await assert.rejects(hp.set('hot_water_setpoint', 99), RangeError);
    await assert.rejects(hp.set('operating_mode', 9), RangeError);
    await assert.rejects(hp.set('outdoor_temperature', 5), RangeError);
});

test('push messages update values but not composite counter parts', () => {
    const hp = new nwpm.HeatPump(new FakeClient({}), log);
    hp.client.emit('message', nwpm.TOPIC_CHANGED + '/1300-1302i', {
        batch: { value_batch: { '1301a': { value: '-3.5' }, '1581u': { value: '1' }, '1300i': { value: '0' }, '9999x': { value: '1' }, '1582i': { value: null } } },
    });
    assert.equal(hp.values['1301a'], -3.5);
    assert.equal(hp.values['1581i'], 1);
    assert.equal('1300i' in hp.values, false);
    assert.equal('1582i' in hp.values, false);
    hp.client.emit('message', nwpm.TOPIC_TWIN, { meta: { applianceSerial: 'X1' }, telemetry: { '1300a': '24.0' } });
    assert.equal(hp.twin.meta.applianceSerial, 'X1');
    assert.equal(hp.values['1300a'], 24);
    hp.client.emit('message', nwpm.TOPIC_APPLIANCE_TIME, { utc_offset_minutes: 60 });
    assert.equal(hp.utcOffsetMinutes, 60);
});

test('setTime uses the gateway UTC offset', async () => {
    const hp = new nwpm.HeatPump(new FakeClient({}), log);
    hp.utcOffsetMinutes = 120;
    await hp.setTime(new Date('2026-10-17T10:00:05.123Z'));
    assert.equal(hp.client.time, '2026-10-17T12:00:05');
});

test('a rejected range is read datapoint by datapoint (operating mode 714 next to an unknown 715)', async () => {
    const client = new FakeClient({ ...require('./fixtures/values.json'), '714i': 1 });
    const asked = [];
    const orig = client.getValues.bind(client);
    client.getValues = async name => {
        asked.push(name);
        if (name === '714-715u' || name === '715u') {
            throw new nwpm.DimplexRequestError(1, 'unknown datapoint');
        }
        return orig(name);
    };
    const hp = new nwpm.HeatPump(client, log);
    await hp.update();
    assert.equal(hp.value('operating_mode'), 1);
    assert.ok(asked.includes('714u') && asked.includes('715u'));
    // the rejected single datapoint is not asked again on the next poll
    asked.length = 0;
    await hp.update();
    assert.ok(asked.includes('714-715u') && asked.includes('714u') && !asked.includes('715u'));
});

