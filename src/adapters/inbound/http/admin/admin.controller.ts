import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';

import type { AdminUseCases } from '../../../../composition/admin-use-cases';
import { ADMIN_USE_CASES } from '../../../../composition/tokens';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { httpError } from '../http-params';

const actor = (request: AuthenticatedRequest) => request.operator?.username ?? 'unknown';
const field = (body: unknown, name: string): unknown => (body as Record<string, unknown> | undefined)?.[name];

function optional<T>(body: unknown, name: string, type: 'string' | 'boolean'): T | undefined {
  const value = field(body, name);
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new BadRequestException({ error: 'INVALID_REQUEST', field: name });
  return value as T;
}

function required<T>(body: unknown, name: string, type: 'string' | 'boolean'): T {
  const value = optional<T>(body, name, type);
  if (value === undefined) throw new BadRequestException({ error: 'INVALID_REQUEST', field: name });
  return value;
}

/** Administration from the interface (§13): concept catalog (§4.3) and archive copy (§10.5). Operator accounts are not managed here. */
@Controller()
export class AdminController {
  constructor(@Inject(ADMIN_USE_CASES) private readonly useCases: AdminUseCases) {}

  /** Every concept, active and retired. */
  @Get('concepts')
  async concepts() {
    return { concepts: await this.useCases.listConcepts.execute() };
  }

  /** `{ "key": "CUOTA EXTRA", "subject": "Cuota extra" }`; the new concept is active. */
  @Post('concepts')
  @HttpCode(201)
  async addConcept(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.concepts.add(actor(request), required<string>(body, 'key', 'string'), required<string>(body, 'subject', 'string'));
    if (!result.ok) {
      const { code, ...details } = result.error;
      throw httpError(code, details);
    }
    return result.value;
  }

  /** `{ "subject"?: string, "active"?: boolean }`: new subject, retire (`false`) or reactivate (`true`). The key cannot change. */
  @Patch('concepts/:key')
  @HttpCode(200)
  async updateConcept(@Param('key') key: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const subject = optional<string>(body, 'subject', 'string');
    const active = optional<boolean>(body, 'active', 'boolean');
    const result = await this.useCases.concepts.update(actor(request), key, { ...(subject === undefined ? {} : { subject }), ...(active === undefined ? {} : { active }) });
    if (!result.ok) throw httpError(result.error.code);
    return result.value;
  }

  @Get('settings/archive-copy')
  archiveCopy() {
    return this.useCases.archiveCopy.get();
  }

  /** `{ "enabled": boolean }`; applies from the next execution. */
  @Put('settings/archive-copy')
  @HttpCode(200)
  async setArchiveCopy(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.archiveCopy.set(actor(request), required<boolean>(body, 'enabled', 'boolean'));
    if (!result.ok) throw httpError(result.error.code);
    return result.value;
  }
}
