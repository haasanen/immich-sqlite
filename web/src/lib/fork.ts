// Fork invariant: this product is browse-only. Users never upload — the
// server hard-rejects upload routes, and the web app must not offer any
// upload affordance. This is not a configuration switch; it is a product
// fact. See server/src/utils/browse-only.ts for the matching server gate.
export const BROWSE_ONLY: boolean = true;
