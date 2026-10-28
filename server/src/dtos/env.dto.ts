import z from 'zod';
import { ImmichEnvironmentSchema, LogFormatSchema, LogLevelSchema } from 'src/enum.js';
import { IsIPRange } from 'src/validation.js';

const absolutePath = z.string().regex(/^\//, 'Must be an absolute path').optional();
/**
 * Treat certain strings as booleans and coerce them to boolean
 * Ideal for environment variables that are strings but should be treated as booleans
 * @docs https://zod.dev/api?id=stringbool
 */
const stringBool = z.stringbool();

const trustedProxiesSchema = z
  .string()
  .optional()
  .transform((s) =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined,
  )

  .pipe(z.union([z.undefined(), IsIPRange({ requireCIDR: false })]));

export const EnvSchema = z
  .object({
    IMMICH_API_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_BUILD_DATA: z.string().optional(),
    IMMICH_BUILD: z.string().optional(),
    IMMICH_BUILD_URL: z.string().optional(),
    IMMICH_BUILD_IMAGE: z.string().optional(),
    IMMICH_BUILD_IMAGE_URL: z.string().optional(),
    IMMICH_CONFIG_FILE: z.string().optional(),
    IMMICH_HELMET_FILE: z.string().optional(),
    IMMICH_ENV: ImmichEnvironmentSchema.optional(),
    IMMICH_HOST: z.string().optional(),
    IMMICH_IGNORE_MOUNT_CHECK_ERRORS: stringBool.optional(),
    IMMICH_LOG_LEVEL: LogLevelSchema.optional(),
    IMMICH_LOG_FORMAT: LogFormatSchema.optional(),
    IMMICH_MEDIA_LOCATION: absolutePath,
    IMMICH_MICROSERVICES_METRICS_PORT: z.coerce.number().int().optional(),
    IMMICH_ALLOW_EXTERNAL_PLUGINS: stringBool.optional(),
    IMMICH_PLUGINS_INSTALL_FOLDER: absolutePath,
    IMMICH_PORT: z.coerce.number().int().optional(),
    IMMICH_REPOSITORY: z.string().optional(),
    IMMICH_REPOSITORY_URL: z.string().optional(),
    IMMICH_SOURCE_REF: z.string().optional(),
    IMMICH_SOURCE_COMMIT: z.string().optional(),
    IMMICH_SOURCE_URL: z.string().optional(),
    IMMICH_TELEMETRY_INCLUDE: z.string().optional(),
    IMMICH_TELEMETRY_EXCLUDE: z.string().optional(),
    IMMICH_THIRD_PARTY_SOURCE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_BUG_FEATURE_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_DOCUMENTATION_URL: z.string().optional(),
    IMMICH_THIRD_PARTY_SUPPORT_URL: z.string().optional(),
    IMMICH_ALLOW_SETUP: stringBool.optional(),
    IMMICH_TRUSTED_PROXIES: trustedProxiesSchema,
    IMMICH_WORKERS_INCLUDE: z.string().optional(),
    IMMICH_WORKERS_EXCLUDE: z.string().optional(),
    DB_SKIP_MIGRATIONS: stringBool.optional(),
    DB_LOCATION: z.string().optional(),
    NO_COLOR: z.string().optional(),
  })
  .meta({ id: 'EnvDto' });
