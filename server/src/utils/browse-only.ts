/**
 * Fork invariant: this product has no upload feature. All user upload
 * surfaces (POST /assets, POST /assets/bulk-upload-check) are hard-disabled;
 * the library is populated exclusively by read-only external library scans.
 * There is no configuration switch — the only exemption is the automated
 * test harness (NODE_ENV=test), which exercises the upload code paths that
 * upstream compatibility requires to remain in the tree.
 */
export const isBrowseOnly = (): boolean => process.env.NODE_ENV !== 'test';
