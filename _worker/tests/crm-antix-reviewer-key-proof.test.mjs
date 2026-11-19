import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import worker from '../crm-worker.js';
import { buildRegistry } from './_registry-fixture.mjs';
import { validateReviewerPublicKey } from '../crm-antix-reviewer-key-proof.js';

const origin = 'https://nasr-crm-api-test.example.workers.dev';
test('protected reviewer key proof verifies possession without enabling or enrolling reviewer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-key-proof-'));
  try {
    const { sqlite, db } = buildRegistry({ ledger: true });
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pk8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
    const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
    const keyFile = path.join(dir, 'private.pk8'); fs.writeFileSync(keyFile, pk8, { mode: 0o600 });
    const fingerprint = crypto.createHash('sha256').update(spki).digest('hex'), now = Date.now();
    const challenge = { reviewerId: 'synthetic-owner', fingerprint, nonce: crypto.randomBytes(32).toString('base64url'), expiresAt: now + 90000 };
    const run = input => spawnSync(process.execPath, ['scripts/antix-wa-sync/sign-reviewer-key-proof.mjs', keyFile],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
    const signed = run(challenge); assert.equal(signed.status, 0, signed.stderr);
    const proof = JSON.parse(signed.stdout);
    assert.equal(proof.publicKey, spki.toString('base64url'));
    assert.doesNotMatch(signed.stdout, /PRIVATE|BEGIN/);
    assert.equal(run({ ...challenge, fingerprint: '0'.repeat(64) }).status, 1);
    assert.equal(run({ ...challenge, expiresAt: now - 1 }).status, 1);
    await validateReviewerPublicKey(proof.publicKey, fingerprint);
    await assert.rejects(validateReviewerPublicKey(proof.publicKey, '0'.repeat(64)));
    fs.chmodSync(keyFile, 0o644); assert.equal(run(challenge).status, 1); fs.chmodSync(keyFile, 0o600);

    const env = { DB: db, ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
      CRM_ALLOWED_ORIGIN: origin, CRM_ACCESS_CODE: crypto.randomBytes(24).toString('base64url'),
      CRM_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'), CRM_SITE_SOURCE_ID: '1', CRM_NASR_AREA_IDS: '1,2' };
    const login = await worker.fetch(new Request(`${origin}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ access_code: env.CRM_ACCESS_CODE }) }), env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf_token;
    const post = (body, headers = {}) => worker.fetch(new Request(`${origin}/api/antix/reviewer-key-proof`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie, 'x-crm-csrf': csrf, ...headers }, body: JSON.stringify(body) }), env);
    assert.equal((await post(proof)).status, 503);
    Object.assign(env, { CRM_ANTIX_ENROLL_PROOF_ENABLED: 'true', CRM_ANTIX_ENROLL_REVIEWER_ID: challenge.reviewerId,
      CRM_ANTIX_ENROLL_PUBLIC_SHA256: fingerprint, CRM_ANTIX_ENROLL_CHALLENGE: challenge.nonce,
      CRM_ANTIX_ENROLL_EXPIRES_AT: String(challenge.expiresAt) });
    assert.equal((await post(proof, { cookie: '' })).status, 401);
    assert.equal((await post(proof, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post(proof, { 'x-crm-csrf': '' })).status, 403);
    const before = sqlite.prepare('SELECT count(*) n FROM crm_contacts').get().n;
    const response = await post(proof); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mode: 'key_possession_only_not_enrolled', verified: true });
    assert.equal(sqlite.prepare('SELECT count(*) n FROM crm_contacts').get().n, before);
    assert.equal((await post({ ...proof, enabled: true })).status, 400);
    env.CRM_ANTIX_ENROLL_PUBLIC_SHA256 = '0'.repeat(64);
    assert.equal((await post(proof)).status, 400);
    env.CRM_ANTIX_ENROLL_PUBLIC_SHA256 = fingerprint;
    env.CRM_ANTIX_ENROLL_CHALLENGE = crypto.randomBytes(32).toString('base64url');
    assert.equal((await post(proof)).status, 400);
    env.CRM_ANTIX_ENROLL_CHALLENGE = challenge.nonce;
    env.CRM_ANTIX_ENROLL_REVIEWER_ID = 'somebody-else';
    assert.equal((await post(proof)).status, 400);
    env.CRM_ANTIX_ENROLL_REVIEWER_ID = challenge.reviewerId;
    env.CRM_ANTIX_ENROLL_EXPIRES_AT = String(now - 1);
    assert.equal((await post(proof)).status, 503);
    env.CRM_ANTIX_ENROLL_EXPIRES_AT = String(now + 700000);
    assert.equal((await post(proof)).status, 503);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='antix_reviewed_messages'").get().n, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
