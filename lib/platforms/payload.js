// A blog on a Payload CMS site (Payload 3 REST API). The account's access_token is a Payload
// API key; social_accounts.metadata holds where to post:
//   site_url         https://example.com (no trailing slash)
//   collection       the posts collection's slug (default 'posts')
//   auth_collection  the collection the API key's user belongs to (default 'users')
//   url_pattern      public URL of a post, '{slug}' replaced (default '/blog/{slug}')
//
// The post text is the article body, sent as-is: the site this was built for stores Markdown
// in a plain textarea field and renders it itself. Everything else an article needs (title,
// excerpt, author, ...) is chosen per post in the composer's blog panel and travels in
// posts.platform_options.payload.
//
// FIELDS and RELATIONS below are that site's collection shape. A site with different field
// names needs them changed here; nothing else in the app knows them.

export const DEFAULT_COLLECTION = 'posts';
export const DEFAULT_AUTH_COLLECTION = 'users';
export const DEFAULT_URL_PATTERN = '/blog/{slug}';

const FIELDS = {
  title: 'title',
  slug: 'slug',
  excerpt: 'excerpt',
  body: 'content',
  author: 'author',
  category: 'category',
  tags: 'tags',
  publishedAt: 'publishedAt',
  emoji: 'featuredEmoji',
  seoKeywords: 'seoKeywords',
  ctaLevel: 'ctaLevel',
};

// The collections the author / category / tags pickers list, and the field shown as each
// one's name.
const RELATIONS = {
  authors: { collection: 'authors', label: 'name' },
  categories: { collection: 'categories', label: 'name' },
  tags: { collection: 'tags', label: 'name' },
};

const REQUEST_TIMEOUT_MS = 15000;

export function siteConfig(account) {
  const metadata = account.metadata || {};
  return {
    siteUrl: metadata.site_url,
    collection: metadata.collection || DEFAULT_COLLECTION,
    authCollection: metadata.auth_collection || DEFAULT_AUTH_COLLECTION,
    urlPattern: metadata.url_pattern || DEFAULT_URL_PATTERN,
  };
}

// Payload reports a refused document as { errors: [{ message, data: { errors: [{ path,
// message }] } }] }; the per-field messages are the useful part ("excerpt: This field is
// required").
function describeError(body) {
  const first = body?.errors?.[0];
  if (!first) return body?.message || 'no details given';
  const fieldErrors = (first.data?.errors || [])
    .map((e) => [e.path || e.field, e.message].filter(Boolean).join(': '))
    .filter(Boolean);
  return fieldErrors.length ? `${first.message} ${fieldErrors.join('; ')}` : first.message;
}

// One authenticated call to the site's REST API. Throws "Payload <what> failed (<status>):
// <reason>", the shape lib/reconnect.js and the failed-post banner expect from an adapter.
export async function payloadRequest({ siteUrl, authCollection, apiKey }, apiPath, { what, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${siteUrl}/api/${apiPath}`, {
      method,
      headers: {
        Authorization: `${authCollection} API-Key ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Payload ${what} failed: could not reach ${siteUrl} (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Payload ${what} failed (${res.status}): ${describeError(data)}`);
  }
  return data;
}

function accountRequest(account, apiPath, options) {
  const { siteUrl, authCollection } = siteConfig(account);
  return payloadRequest({ siteUrl, authCollection, apiKey: account.access_token }, apiPath, options);
}

// The authors, categories and tags the site currently has, for the composer's pickers.
export async function fetchBlogOptions(account) {
  const entries = await Promise.all(
    Object.entries(RELATIONS).map(async ([key, { collection, label }]) => {
      const data = await accountRequest(account, `${collection}?limit=200&depth=0&sort=${label}`, {
        what: `${key} lookup`,
      });
      return [key, (data.docs || []).map((doc) => ({ id: doc.id, name: doc[label] ?? String(doc.id) }))];
    })
  );
  return Object.fromEntries(entries);
}

export function postUrl(account, slug) {
  const { siteUrl, urlPattern } = siteConfig(account);
  return slug ? `${siteUrl}${urlPattern.replace('{slug}', slug)}` : null;
}

const REQUIRED_OPTIONS = { title: 'a title', excerpt: 'an excerpt', author: 'an author', category: 'a category' };

export async function publish(post) {
  const options = post.platform_options?.payload || {};
  const missing = Object.entries(REQUIRED_OPTIONS)
    .filter(([key]) => !options[key])
    .map(([, label]) => label);
  if (missing.length) {
    throw new Error(`Payload blog post is missing ${missing.join(', ')}. Edit the post and fill in its blog settings.`);
  }
  if (post.media?.length) {
    throw new Error('Payload blog posts are text only: remove the attached media and try again.');
  }

  const seoMeta = {
    ...(options.seo_title ? { title: options.seo_title } : {}),
    ...(options.seo_description ? { description: options.seo_description } : {}),
  };
  const body = {
    [FIELDS.title]: options.title,
    ...(options.slug ? { [FIELDS.slug]: options.slug } : {}),
    [FIELDS.excerpt]: options.excerpt,
    [FIELDS.body]: post.content,
    [FIELDS.author]: options.author,
    [FIELDS.category]: options.category,
    ...(options.tags?.length ? { [FIELDS.tags]: options.tags } : {}),
    [FIELDS.publishedAt]: new Date().toISOString(),
    ...(options.featured_emoji ? { [FIELDS.emoji]: options.featured_emoji } : {}),
    ...(options.seo_keywords?.length ? { [FIELDS.seoKeywords]: options.seo_keywords } : {}),
    ...(options.cta_level ? { [FIELDS.ctaLevel]: options.cta_level } : {}),
    ...(Object.keys(seoMeta).length ? { meta: seoMeta } : {}),
    _status: 'published',
  };

  const { collection } = siteConfig(post);
  const created = await accountRequest(post, collection, { what: 'publish', method: 'POST', body });
  const id = created.doc?.id;
  if (id === undefined || id === null) {
    throw new Error('Payload publish failed: the site accepted the post but returned no id.');
  }
  return String(id);
}
