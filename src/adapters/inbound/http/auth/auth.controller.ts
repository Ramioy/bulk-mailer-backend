import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';

import type { AuthUseCases } from '../../../../application/auth/auth-use-cases';
import { AUTH_USE_CASES } from '../../../../composition/tokens';
import type { SignedIn } from '../../../../ports/authenticator';
import type { AuthenticatedRequest } from './bearer-auth.guard';
import { Public } from './public.decorator';

function requireStrings<K extends string>(body: unknown, keys: readonly K[]): Record<K, string> {
  const value = body as Record<string, unknown> | null | undefined;
  for (const key of keys) {
    if (typeof value?.[key] !== 'string' || value[key] === '') throw new BadRequestException({ error: 'INVALID_REQUEST', field: key });
  }
  return value as Record<K, string>;
}

const session = ({ operator, tokens }: SignedIn) => ({
  operator,
  accessToken: tokens.accessToken,
  accessExpiresAt: tokens.accessExpiresAt.toISOString(),
  refreshToken: tokens.refreshToken,
  refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_USE_CASES) private readonly auth: AuthUseCases) {}

  @Public()
  @Post('sign-in')
  @HttpCode(200)
  async signIn(@Body() body: unknown) {
    const { username, password } = requireStrings(body, ['username', 'password']);
    const result = await this.auth.signIn(username, password);
    if (!result.ok) throw new UnauthorizedException({ error: result.error });
    return session(result.value);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const { refreshToken } = requireStrings(body, ['refreshToken']);
    const result = await this.auth.refresh(refreshToken);
    if (!result.ok) throw new UnauthorizedException({ error: result.error });
    return session(result.value);
  }

  /** Authenticated by the refresh token, so it works even after the access token expired. Idempotent. */
  @Public()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Body() body: unknown): Promise<void> {
    const { refreshToken } = requireStrings(body, ['refreshToken']);
    await this.auth.signOut(refreshToken);
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    const operator = request.operator;
    return operator && { ...operator, accessExpiresAt: operator.accessExpiresAt.toISOString() };
  }
}
