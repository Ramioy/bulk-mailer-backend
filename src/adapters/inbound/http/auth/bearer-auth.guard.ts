import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { AUTHENTICATOR } from '../../../../composition/tokens';
import type { AuthenticatedOperator, Authenticator } from '../../../../ports/authenticator';
import { IS_PUBLIC } from './public.decorator';

export type AuthenticatedRequest = FastifyRequest & { operator?: AuthenticatedOperator };

/** Every route requires `Authorization: Bearer <access token>` unless marked @Public(). */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException({ error: 'INVALID_ACCESS_TOKEN' });

    const verified = await this.authenticator.verify(token);
    if (!verified.ok) throw new UnauthorizedException({ error: verified.error });
    request.operator = verified.value;
    return true;
  }
}
