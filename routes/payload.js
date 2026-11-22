import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logProductEvent } from '../lib/activityLog.js';
import { atAccountLimit } from '../middleware/planLimit.js';
import {
  payloadRequest,
  fetchBlogOptions,
  DEFAULT_COLLECTION,
  DEFAULT_AUTH_COLLECTION,
  DEFAULT_URL_PATTERN,
} from '../lib/platforms/payload.js';

const router = Router();

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'letters, numbers, - and _ only')
  .max(64);

// https only, except plain http while developing against a local site.
const siteUrl = z
  .string()
  .trim()
  .url()
  .max(255)
  .refine((value) => /^https:\/\//i.test(value) || (process.env.NODE_ENV !== 'production' && /^http:\/\//i.test(value)), {
    message: 'must start with https://',
  })
  .transform((value) => new URL(value).origin);

const connectSchema = z.object({
  site_url: siteUrl,
  api_key: z.string().trim().min(8).max(255),
  collection: slug.optional(),
  auth_collection: slug.optional(),
  url_pattern: z
    .string()
    .trim()
    .max(255)
    .regex(/^\/[^\s]*\{slug\}[^\s]*$/, 'must start with / and contain {slug}')
    .optional(),
});

// The user creates an API key for a user on their Payload site (Users -> Enable API Key) and
// hands it over with the site's address. Both are checked against the site before anything
// is stored: the key by asking who it belongs to, the collection by reading from it.
router.post(
  '/connect',
  validate(connectSchema),
  asyncHandler(async (req, res) => {
    const {
      site_url: site,
      api_key: apiKey,
      collection = DEFAULT_COLLECTION,
      auth_collection: authCollection = DEFAULT_AUTH_COLLECTION,
      url_pattern: urlPattern = DEFAULT_URL_PATTERN,
    } = req.body;
    const connection = { siteUrl: site, authCollection, apiKey };

    let me;
    try {
      me = await payloadRequest(connection, `${authCollection}/me`, { what: 'sign-in' });
    } catch (err) {
      return res.status(400).json({ error: 'site_unreachable', message: err.message });
    }
    if (!me.user) {
      return res.status(400).json({
        error: 'invalid_credentials',
        message: `${site} did not accept that API key. Check the key and that API keys are enabled for its user.`,
      });
    }
    try {
      await payloadRequest(connection, `${collection}?limit=1&depth=0`, { what: `"${collection}" collection check` });
    } catch (err) {
      return res.status(400).json({ error: 'invalid_collection', message: err.message });
    }

    const host = new URL(site).host;
    const externalId = `${host}/${collection}`;
    const existing = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'payload' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (existing.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.status(402).json({
        error: 'plan_limit',
        message: 'Your plan is at its connected-account limit. Upgrade at /pricing to add more.',
      });
    }

    const metadata = { site_url: site, collection, auth_collection: authCollection, url_pattern: urlPattern };
    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'payload', $2, $3, $4, $5)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
                     metadata = EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, host, externalId, apiKey, metadata]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'payload',
        socialAccountId: result.rows[0].id,
      }).catch((err) => req.log.error({ err }, 'failed to record product event'));
    }

    res.status(201).json({ id: result.rows[0].id, display_name: host });
  })
);

// The site's authors, categories and tags, for the composer's blog panel. Read live each time
// the panel opens, so a category added on the site shows up without reconnecting.
router.get(
  '/accounts/:id/options',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query(
      `SELECT id, access_token, metadata FROM social_accounts
       WHERE id = $1 AND user_id = $2 AND platform = 'payload'`,
      [id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });

    try {
      res.json(await fetchBlogOptions(rows[0]));
    } catch (err) {
      req.log.warn({ err, socialAccountId: id }, 'payload blog options lookup failed');
      res.status(502).json({ error: 'site_unreachable', message: err.message });
    }
  })
);

export default router;
