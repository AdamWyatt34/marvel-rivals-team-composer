/**
 * Cloudflare Worker: CORS-enabled forwarder for the profile-import feature.
 * RivalsMeta's API sends no Access-Control-Allow-Origin header, so the
 * browser can't call it directly from the site.
 *
 * Deploy (free tier is ample):
 *   1. Cloudflare dashboard -> Workers -> Create -> paste this file, deploy.
 *   2. Repo Settings -> Actions -> Variables -> PROFILE_PROXY_URL =
 *      https://<worker-name>.<account>.workers.dev
 *   3. Re-run the Pages deploy; the import UI appears once the build sees it.
 *
 * Only the read-only endpoints the site needs are forwarded, and responses
 * are edge-cached to keep traffic to RivalsMeta minimal.
 */

const ALLOWED =
  /^\/api\/(player-match-history\/\d+|player\/\d+|matches\/[\w-]+)$/;
const CACHE_SECONDS = 600;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: CORS_HEADERS,
      });
    }
    const url = new URL(request.url);
    if (!ALLOWED.test(url.pathname)) {
      return new Response("forbidden", { status: 403, headers: CORS_HEADERS });
    }
    const upstream = await fetch(
      `https://rivalsmeta.com${url.pathname}${url.search}`,
      {
        headers: {
          "User-Agent":
            "marvel-rivals-team-composer/1.0 (+https://github.com/AdamWyatt34/marvel-rivals-team-composer; hobby project)",
          Accept: "application/json",
        },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      },
    );
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      response.headers.set(k, v);
    }
    response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    return response;
  },
};
