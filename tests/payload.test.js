import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `pl${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

const SITE = 'https://blog.example.com';
const API_KEY = 'payload-api-key-123';

// A Payload site that knows one API key and has a `posts` collection.
function mockSite({ collections = ['posts'] } = {}) {
  return vi.fn(async (url, options = {}) => {
    const u = String(url);
    const authorized = options.headers?.Authorization === `users API-Key ${API_KEY}`;
    if (u === `${SITE}/api/users/me`) return jsonResponse({ user: authorized ? { id: 1 } : null });
    const collection = u.match(/\/api\/([a-z-]+)\?/)?.[1];
    if (collection && collections.includes(collection)) {
      return authorized ? jsonResponse({ docs: [] }) : jsonResponse({ errors: [{ message: 'Forbidden' }] }, 403);
    }
    if (collection) return jsonResponse({ errors: [{ message: 'Not Found' }] }, 404);
    throw new Error(`unexpected fetch: ${u}`);
  });
}

async function connect(client, body = {}) {
  return client.post('/api/payload/connect').send({ site_url: SITE, api_key: API_KEY, ...body });
}

describe('payload blog connect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).post('/api/payload/connect').send({ site_url: SITE, api_key: API_KEY });
    expect(res.status).toBe(401);
  });

  it('rejects a site address that is not a URL before calling anything', async () => {
    const client = await loginNewUser();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await connect(client, { site_url: 'not a url' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the account with its site settings once the key is accepted', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());

    const res = await connect(client, { site_url: `${SITE}/admin/` });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('blog.example.com');

    const { rows } = await pool.query(
      'SELECT platform, display_name, external_account_id, access_token, metadata FROM social_accounts WHERE id = $1',
      [res.body.id]
    );
    expect(rows[0]).toMatchObject({
      platform: 'payload',
      display_name: 'blog.example.com',
      external_account_id: 'blog.example.com/posts',
      access_token: API_KEY,
      metadata: { site_url: SITE, collection: 'posts', auth_collection: 'users', url_pattern: '/blog/{slug}' },
    });
  });

  it('rejects an API key the site does not know', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const res = await connect(client, { api_key: 'some-other-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects a collection the site does not have', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const res = await connect(client, { collection: 'articles' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_collection');
  });

  it('updates the stored key when the same blog is connected again', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const first = await connect(client);
    const second = await connect(client, { url_pattern: '/articles/{slug}' });
    expect(second.body.id).toBe(first.body.id);
    const { rows } = await pool.query('SELECT metadata FROM social_accounts WHERE id = $1', [first.body.id]);
    expect(rows[0].metadata.url_pattern).toBe('/articles/{slug}');
  });
});

describe('payload blog options', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the site's authors, categories and tags", async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const account = await connect(client);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        expect(options.headers.Authorization).toBe(`users API-Key ${API_KEY}`);
        if (u.startsWith(`${SITE}/api/authors?`)) return jsonResponse({ docs: [{ id: 3, name: 'Roger', slug: 'roger' }] });
        if (u.startsWith(`${SITE}/api/categories?`)) return jsonResponse({ docs: [{ id: 7, name: 'Guides' }] });
        if (u.startsWith(`${SITE}/api/tags?`)) return jsonResponse({ docs: [{ id: 1, name: 'crm' }, { id: 2, name: 'santa' }] });
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get(`/api/payload/accounts/${account.body.id}/options`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authors: [{ id: 3, name: 'Roger' }],
      categories: [{ id: 7, name: 'Guides' }],
      tags: [
        { id: 1, name: 'crm' },
        { id: 2, name: 'santa' },
      ],
    });
  });

  it("doesn't list options for someone else's blog", async () => {
    const owner = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const account = await connect(owner);

    const other = await loginNewUser();
    const res = await other.get(`/api/payload/accounts/${account.body.id}/options`);
    expect(res.status).toBe(404);
  });

  it('reports a site that cannot be reached', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockSite());
    const account = await connect(client);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }, 401)));
    const res = await client.get(`/api/payload/accounts/${account.body.id}/options`);
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/401/);
  });
});
