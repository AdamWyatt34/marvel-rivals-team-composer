import * as devalue from "devalue";

/**
 * The ONLY module that knows RivalsMeta pages are Nuxt SSR apps.
 * Extracts the #__NUXT_DATA__ script tag from a page and decodes its
 * devalue-flattened payload, tolerating Nuxt's reactivity wrapper types.
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
  data: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export function parseNuxtPage(html: string): NuxtPayload {
  const match = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s,
  );
  if (!match) {
    throw new Error(
      "No __NUXT_DATA__ script tag found — RivalsMeta page structure changed",
    );
  }
  const payload = devalue.unflatten(
    JSON.parse(match[1]),
    nuxtRevivers,
  ) as NuxtPayload;
  if (payload == null || typeof payload !== "object" || payload.data == null) {
    throw new Error("__NUXT_DATA__ decoded to an unexpected shape");
  }
  return payload;
}

/** The route data object, regardless of the opaque hash key it sits under. */
export function routeData<T>(payload: NuxtPayload): T {
  const values = Object.values(payload.data);
  if (values.length !== 1) {
    throw new Error(
      `Expected exactly one route-data entry, got ${values.length}`,
    );
  }
  return values[0] as T;
}
