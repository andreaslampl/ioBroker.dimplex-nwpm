#!/usr/bin/env node
'use strict';

/*
 * Recover the MQTT password of an old ioBroker installation from a backup.
 *
 * Usage (on the ioBroker host):
 *   node find-old-mqtt-password.js <backup.tar.gz | objects.jsonl | objects.json | backup.json>
 *
 * Looks for system.config (encryption secret) and every mqtt/mqtt-client
 * adapter instance, and prints their host, user and decrypted password.
 * Nothing is sent anywhere.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function readText(file) {
    let data = fs.readFileSync(file);
    if (data[0] === 0x1f && data[1] === 0x8b) {
        data = zlib.gunzipSync(data);
    }
    // A tar archive is fine as is: we only search the JSON text inside it.
    // Nested .gz files (BackItUp stores objects.jsonl.gz / backup.json.gz) are unpacked too.
    let text = data.toString('latin1');
    const nested = [];
    for (let i = data.indexOf(Buffer.from([0x1f, 0x8b, 0x08])); i >= 0; i = data.indexOf(Buffer.from([0x1f, 0x8b, 0x08]), i + 1)) {
        try {
            nested.push(zlib.gunzipSync(data.subarray(i), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
        } catch {
            // not a gzip stream
        }
    }
    return [text, ...nested].join('\n');
}

function decrypt(secret, value) {
    if (typeof value !== 'string' || !value) {
        return value;
    }
    const m = /^\$\/aes-192-cbc:([0-9a-f]+):(.+)$/.exec(value);
    if (m) {
        const key = Buffer.from(secret, 'hex').subarray(0, 24);
        const d = crypto.createDecipheriv('aes-192-cbc', key, Buffer.from(m[1], 'hex'));
        return Buffer.concat([d.update(m[2], 'base64'), d.final()]).toString('utf8');
    }
    let out = '';
    for (let i = 0; i < value.length; i++) {
        out += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return out;
}

const file = process.argv[2];
if (!file) {
    console.error('Usage: node find-old-mqtt-password.js <backup file>');
    process.exit(1);
}
const text = readText(file);
const secretMatch = /"_id"\s*:\s*"system\.config"[\s\S]{0,20000}?"secret"\s*:\s*"([0-9a-f]+)"/.exec(text) || /"secret"\s*:\s*"([0-9a-f]{32,})"/.exec(text);
if (!secretMatch) {
    console.error('No system.config secret found in this file.');
}
const secret = secretMatch && secretMatch[1];
const re = /"(system\.adapter\.mqtt(?:-client)?\.\d+)"/g;
const seen = new Set();
let m;
let found = 0;
while ((m = re.exec(text)) !== null) {
    if (seen.has(m[1])) {
        continue;
    }
    const chunk = text.slice(m.index, m.index + 30000);
    const native = /"native"\s*:\s*\{[\s\S]*?\}/.exec(chunk);
    if (!native) {
        continue;
    }
    const get = k => {
        const r = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(native[0]);
        return r ? JSON.parse(`"${r[1]}"`) : undefined;
    };
    const pass = get('pass') ?? get('password');
    if (pass === undefined && get('url') === undefined && get('host') === undefined) {
        continue;
    }
    seen.add(m[1]);
    found++;
    console.log(`\n${m[1]}`);
    console.log(`  type:     ${get('type') ?? '-'}`);
    console.log(`  host/url: ${get('url') ?? get('host') ?? '-'}  port: ${(/"port"\s*:\s*"?(\d+)/.exec(native[0]) || [])[1] ?? '-'}`);
    console.log(`  user:     ${get('user') ?? get('username') ?? '-'}`);
    console.log(`  password: ${pass ? (secret ? decrypt(secret, pass) : `${pass} (encrypted, no secret found)`) : '-'}`);
}
if (!found) {
    console.log('No MQTT adapter instance with credentials found in this file.');
}
