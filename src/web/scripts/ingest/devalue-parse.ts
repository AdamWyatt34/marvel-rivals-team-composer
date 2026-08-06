import * as devalue from "devalue";

/**
 * The ONLY module that knows RivalsMeta pages are Nuxt SSR apps.
 *
 * Route data (useAsyncData results) is served as a separate devalue-flattened
 * document at <route>/_payload.json (Nuxt payload extraction); the page HTML's
 * #__NUXT_DATA__ script now carries only app state (Pinia stores etc.), not
 * route data.
 */

const identity = <T>(v: T): T => v;

// Nuxt serializes refs/reactive wrappers as custom devalue types; the inner
// value is all we care about.
const nuxtRevivers: Record<string, (value: unknown) => unknown> = {
  NuxtError: identity,
  EmptyShallowRef: identity,
  EmptyRef: identity,
  ShallowRef: identity,
  ShallowReactive: identity,
  Ref: identity,
  Reactive: identity,
};

export interface NuxtPayload {
  /** Keyed by an opaque per-route hash; the single value is the route's data. */
  data?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

function decode(flattened: string, source: string): NuxtPayload {
  const payload = devalue.unflatten(
    JSON.parse(flattened),
    nuxtRevivers,
  ) as NuxtPayload;
  if (
    payload == null ||
    typeof payload !== "object" ||
    (payload.data == null && payload.state == null)
  ) {
    throw new Error(`${source} decoded to an unexpected shape`);
  }
  return payload;
}

/** The URL serving a route's data document. */
export function payloadUrl(route: string): string {
  return `https://rivalsmeta.com${route}/_payload.json`;
}

/** Decodes a <route>/_payload.json document ({data, prerenderedAt}). */
export function parsePayloadJson(text: string): NuxtPayload {
  return decode(text, "_payload.json");
}

/** Decodes the #__NUXT_DATA__ script of a page (app state, no route data). */
export function parseNuxtPage(html: string): NuxtPayload {
  const match = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s,
  );
  if (!match) {
    throw new Error(
      "No __NUXT_DATA__ script tag found — RivalsMeta page structure changed",
    );
  }
  return decode(match[1], "__NUXT_DATA__");
}

/** The route data object, regardless of the opaque hash key it sits under. */
export function routeData<T>(payload: NuxtPayload): T {
  const values = Object.values(payload.data ?? {});
  if (values.length !== 1) {
    throw new Error(
      `Expected exactly one route-data entry, got ${values.length}`,
    );
  }
  return values[0] as T;
}
