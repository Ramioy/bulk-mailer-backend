import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Routes reachable without an access token: health, sign-in, refresh, sign-out and the provider webhook. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
