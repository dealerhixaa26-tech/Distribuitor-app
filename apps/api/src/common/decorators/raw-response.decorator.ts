import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'hixaa:raw-response';

/**
 * Opts a handler out of the `{ data }` envelope.
 *
 * Used by file downloads, PDF streams, and the health endpoints, whose response
 * bodies are consumed by tools (Docker healthchecks, browsers) that expect a
 * specific shape rather than our envelope.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
