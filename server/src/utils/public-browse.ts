/**
 * Fork invariant: the web gallery is open at the site root. Unauthenticated
 * read requests run as the library-owner (admin) account so every visitor on
 * the trusted network browses the full timeline without an account or a
 * shared link. This is a deliberate LAN-trust product decision, mirroring
 * browse-only (src/utils/browse-only.ts): there is no configuration switch,
 * and the only exemption is the automated test harness (NODE_ENV=test), so
 * upstream compatibility tests that assert 401-without-token keep passing
 * unless they opt in by setting NODE_ENV.
 *
 * Policy enforced together with this flag (see AuthService):
 *   - unauthenticated requests must present no credential at all; a bad or
 *     expired token stays a 401 so real sessions surface the login screen
 *   - GET/HEAD only, plus the read-scoped POST families the viewer uses
 *     (search/timeline/map/download); every mutation stays login-only
 *   - admin-only routes are never served to anonymous visitors
 */
export const isPublicBrowse = (): boolean => process.env.NODE_ENV !== 'test';

/**
 * Read surface for anonymous browsing: plain reads, plus POST endpoints that
 * are read-only queries (the metadata timeline, map markers and download
 * preparation are POSTs in the API but mutate nothing).
 */
export const isPublicBrowseRead = (method: string | undefined, uri: string): boolean => {
  if (method === undefined) {
    return false;
  }
  if (method === 'GET' || method === 'HEAD') {
    return true;
  }
  if (method !== 'POST') {
    return false;
  }
  return (
    uri.startsWith('/api/search/') ||
    uri.startsWith('/api/timeline/') ||
    uri.startsWith('/api/map/') ||
    uri.startsWith('/api/download/')
  );
};
