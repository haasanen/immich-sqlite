// Leaf module: constraint names shared between schema tables and error guards.
// Must not import anything: asset.table.ts is evaluated during schema init, so these
// constants cannot live in a module that pulls in repositories (TDZ cycle in ESM prod boot).
export const ASSET_CHECKSUM_CONSTRAINT = 'UQ_assets_owner_checksum';
export const VIDEO_STREAM_SESSION_PK_CONSTRAINT = 'video_stream_session_pkey';
