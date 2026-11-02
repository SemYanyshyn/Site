import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import pg from 'pg';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { clearSessionCookie, setSessionCookie } from '../src/server/auth/sessions.js';

const pages = 'https://semyanyshyn.github.io';
const config: AppConfig = { host: '127.0.0.1', port: 0, databaseUrl: 'postgresql://probe@127.0.0.1:1/probe',
  appOrigins: new Set([pages, 'https://courier.example.test']), cookieSecure: true, sessionTtlSeconds: 3600 };

test('real HTTP CORS preflights, safe reads and rejected mutations keep exact origins and RBAC', async (t) => {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 100 });
  const server = createApp({ config, pool }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(3_000) });
  try {
    await t.test('OPTIONS for every API category terminates before auth/DB', async () => {
      for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/jobs', '/api/jobs/id/cancel', '/api/admin/overview', '/api/health']) {
        const response = await request(path, { method: 'OPTIONS', headers: { Origin: pages,
          'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
        assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), pages);
        assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
        assert.match(response.headers.get('vary') ?? '', /Origin/u);
        assert.equal(response.headers.get('set-cookie'), null);
      }
      assert.equal(pool.totalCount, 0);
    });
    await t.test('unknown/null/lookalike origins and unexpected methods/headers receive no CORS grant', async () => {
      for (const origin of ['null', '*', `${pages}.attacker.invalid`, `${pages}/Site/`, 'https://foreign.example.test']) {
        for (const method of ['GET', 'POST', 'OPTIONS']) {
          const response = await request('/api/auth/login', { method, headers: { Origin: origin, 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}) });
          assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
          await response.arrayBuffer();
        }
      }
      for (const headers of [ { Origin: pages, 'Access-Control-Request-Method': 'DELETE' },
        { Origin: pages, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
        { 'Access-Control-Request-Method': 'POST' } ]) {
        assert.equal((await request('/api/jobs', { method: 'OPTIONS', headers })).status, 403);
      }
      assert.equal(pool.totalCount, 0);
    });
    await t.test('read errors remain readable to allowed origins without bypassing authentication', async () => {
      for (const [path, status] of [['/api/health', 200], ['/api/jobs', 401], ['/api/admin/overview', 401], ['/api/not-found', 404]] as const) {
        const response = await request(path, { headers: { Origin: pages } });
        assert.equal(response.status, status); assert.equal(response.headers.get('access-control-allow-origin'), pages);
        assert.match(response.headers.get('access-control-expose-headers') ?? '', /X-Instance-Id/u);
        await response.arrayBuffer();
      }
      assert.equal((await request('/api/health')).status, 200);
      assert.equal(pool.totalCount, 0);
    });
    await t.test('Origin/JSON mutation guards remain effective after CORS', async () => {
      assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await request('/api/auth/login', { method: 'POST', headers: { Origin: pages, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
      assert.equal((await request('/api/auth/login', { method: 'POST', headers: { Origin: pages, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
      assert.equal(pool.totalCount, 0);
    });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await pool.end(); }
});

test('set and clear cookies keep matching host-only HttpOnly/Secure/SameSite policies', async () => {
  const app = express();
  for (const sameSite of ['lax', 'none'] as const) {
    app.get(`/${sameSite}/set`, (_request, response) => {
      setSessionCookie(response, 'test-token', new Date(Date.now() + 60_000), { ...config, sessionCookieSameSite: sameSite }); response.status(204).end();
    });
    app.get(`/${sameSite}/clear`, (_request, response) => {
      clearSessionCookie(response, { ...config, sessionCookieSameSite: sameSite }); response.status(204).end();
    });
  }
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const sameSite of ['lax', 'none']) for (const action of ['set', 'clear']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/${sameSite}/${action}`, { signal: AbortSignal.timeout(3_000) });
      const cookie = response.headers.get('set-cookie') ?? '';
      assert.match(cookie, /; HttpOnly/u); assert.match(cookie, /; Secure/u);
      assert.match(cookie.toLowerCase(), new RegExp(`; samesite=${sameSite}`));
      assert.match(cookie, /; Path=\//u); assert.doesNotMatch(cookie, /; Domain=/iu);
      if (action === 'clear') assert.match(cookie, /Max-Age=0/u);
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
