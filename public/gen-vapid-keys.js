#!/usr/bin/env node
/**
 * gen-vapid-keys.js — one-time setup for Web Push.
 *
 * VAPID is how a push service (Google/Apple/Mozilla) verifies that a push
 * request genuinely came from your app. You generate a P-256 keypair once:
 *   • the PUBLIC key is embedded in the site so browsers can subscribe to you
 *   • the PRIVATE key stays a repo secret and signs every push request
 *
 *   node gen-vapid-keys.js
 */

import crypto from 'node:crypto';

// URL-safe base64 with padding stripped — the encoding the Web Push spec uses.
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// Raw uncompressed public point (0x04 || X || Y) = the 65 bytes browsers expect.
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
const privJwk = privateKey.export({ format: 'jwk' });

console.log('\nVAPID keypair generated.\n');
console.log('PUBLIC KEY  (paste into index.html as VAPID_PUBLIC_KEY):');
console.log('  ' + b64url(pubRaw) + '\n');
console.log('PRIVATE KEY (add as repo secret VAPID_PRIVATE_KEY — never commit this):');
console.log('  ' + privJwk.d + '\n');
console.log('Also set a repo secret VAPID_SUBJECT to a contact URL or mailto:, e.g.');
console.log('  mailto:you@example.com\n');
