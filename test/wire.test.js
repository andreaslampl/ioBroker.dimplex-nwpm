'use strict';

// NwpmClient with the real mqtt.js library against a minimal MQTT v5 server
// (mqtt-packet) that behaves like the NWPM gateway broker.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqttPacket = require('mqtt-packet');
const { NwpmClient } = require('../lib/nwpm');

function startBroker() {
    const seen = { connect: null, subscribe: null, publishes: [] };
    const server = net.createServer(socket => {
        const parser = mqttPacket.parser({ protocolVersion: 5 });
        const send = packet => socket.write(mqttPacket.generate(packet, { protocolVersion: 5 }));
        parser.on('packet', packet => {
            if (packet.cmd === 'connect') {
                seen.connect = packet;
                send({ cmd: 'connack', reasonCode: packet.password.toString() === 'pw' ? 0 : 135, sessionPresent: false });
            } else if (packet.cmd === 'subscribe') {
                seen.subscribe = packet;
                send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
            } else if (packet.cmd === 'publish') {
                seen.publishes.push(packet);
                const req = JSON.parse(packet.payload.toString());
                send({
                    cmd: 'publish',
                    topic: packet.properties.responseTopic,
                    payload: JSON.stringify({ status: 0, content: { value: req.name === '1301a' ? ['-3.5'] : ['1', '0'] } }),
                    qos: 0,
                    properties: { correlationData: packet.properties.correlationData },
                });
            } else if (packet.cmd === 'pingreq') {
                send({ cmd: 'pingresp' });
            }
        });
        socket.on('data', d => parser.parse(d));
        socket.on('error', () => {});
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('request/response over real MQTT v5', async t => {
    const { server, seen, port } = await startBroker();
    const client = new NwpmClient({ host: '127.0.0.1', port, password: 'pw' });
    t.after(async () => {
        await client.disconnect();
        server.close();
    });
    const connected = new Promise(resolve => client.once('connect', resolve));
    client.connect();
    await connected;

    assert.equal(seen.connect.protocolVersion, 5);
    assert.equal(seen.connect.username, 'mqtt');
    assert.ok(seen.subscribe.subscriptions.some(s => s.topic === 'gateway/broadcast/changed_on/modbus/#'));

    assert.deepEqual(await client.getValues('1301a'), { '1301a': -3.5 });
    assert.deepEqual(await client.getValues('1500-1501d'), { '1500d': true, '1501d': false });
    const p = seen.publishes[0];
    assert.equal(p.topic, 'gateway/modbus/get_value/1301a');
    assert.equal(p.properties.responseTopic, `${client.replyRoot}/get_value_reply/1301a`);
    assert.equal(p.properties.correlationData.length, 4);

});

test('wrong password emits authFailed', async t => {
    const { server, port } = await startBroker();
    const client = new NwpmClient({ host: '127.0.0.1', port, password: 'nope' });
    t.after(async () => {
        await client.disconnect();
        server.close();
    });
    const failed = new Promise(resolve => client.once('authFailed', resolve));
    client.connect();
    const err = await failed;
    assert.match(err.message, /rejected the credentials/);
});

