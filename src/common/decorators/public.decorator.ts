import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'mailops:isPublic';

/**
 * Opts a route out of the global API key guard. Reserved for endpoints an
 * external monitor has to reach before it can authenticate — today only
 * `GET /health`.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
