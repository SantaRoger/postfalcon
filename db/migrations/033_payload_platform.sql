-- A Payload CMS blog as a platform (lib/platforms/payload.js): a post publishes as a blog post
-- on the connected site.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram', 'bluesky', 'threads',
    'pinterest', 'linkedin', 'reddit', 'google_business',
    'twitter', 'x', 'payload'
  )
);
