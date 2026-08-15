import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('POST /api/models (add model)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('creates a routable user model on a native platform', async () => {
    const created = await request(app, 'POST', '/api/models', {
      platform: 'groq',
      modelId: 'test-user-model',
      displayName: 'Test User Model',
      contextWindow: 100000,
      supportsVision: true,
      supportsTools: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.model).toMatchObject({ platform: 'groq', modelId: 'test-user-model', source: 'custom' });

    const db = getDb();
    const row = db.prepare("SELECT * FROM models WHERE platform = 'groq' AND model_id = 'test-user-model'").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.source).toBe('user');
    expect(row.enabled).toBe(1);
    expect(row.deprecated).toBe(0);

    // A freshly added model must be routable: a fallback row plus a row in the
    // active profile's model list.
    const modelDbId = row.id as number;
    expect(db.prepare('SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?').get(modelDbId)).toEqual({ n: 1 });

    const profile = db.prepare("SELECT id FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1").get() as { id: number };
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, modelDbId)).toEqual({ n: 1 });
  });

  it('rejects duplicate model ids on the same platform', async () => {
    const dup = await request(app, 'POST', '/api/models', { platform: 'groq', modelId: 'test-user-model' });
    expect(dup.status).toBe(409);
  });

  it('rejects unknown platforms', async () => {
    const unknown = await request(app, 'POST', '/api/models', { platform: 'nope', modelId: 'x' });
    expect(unknown.status).toBe(400);
  });

  it('rejects a custom endpoint that is not registered yet', async () => {
    const res = await request(app, 'POST', '/api/models', {
      platform: 'custom',
      baseUrl: 'https://not-registered.example.com/v1',
      modelId: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/endpoint is not registered/i);
  });

  it('registers a model on an existing custom endpoint', async () => {
    const created = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'ck-test-secret-1',
      models: ['existing-model'],
    });
    expect(created.status).toBe(201);
    const keyId = created.body.keyId as number;

    const added = await request(app, 'POST', '/api/models', {
      platform: 'custom',
      keyId,
      modelId: 'brand-new-model',
      displayName: 'Brand New',
      supportsTools: true,
      supportsVision: false,
    });
    expect(added.status).toBe(201);
    expect(added.body.model).toMatchObject({ platform: 'custom', modelId: 'brand-new-model', source: 'user' });

    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM models WHERE platform = 'custom' AND model_id = 'brand-new-model' AND endpoint_scope = 'https://relay.example.com/v1'",
    ).get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.key_id).toBe(keyId);
    expect(row.source).toBe('user');
    // Routable: fallback chain + active profile membership.
    const modelDbId = row.id as number;
    expect(db.prepare('SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?').get(modelDbId)).toEqual({ n: 1 });
    const profile = db.prepare("SELECT id FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1").get() as { id: number };
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, modelDbId)).toEqual({ n: 1 });
  });
});
