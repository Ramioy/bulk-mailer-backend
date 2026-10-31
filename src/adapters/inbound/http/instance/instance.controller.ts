import { Controller, Get, Inject } from '@nestjs/common';

import type { AdminUseCases } from '../../../../composition/admin-use-cases';
import { ADMIN_USE_CASES } from '../../../../composition/tokens';

/** D47: which instance answered and whether it runs the background work (JWT; `/health` stays minimal). */
@Controller('instance')
export class InstanceController {
  constructor(@Inject(ADMIN_USE_CASES) private readonly useCases: AdminUseCases) {}

  @Get()
  status() {
    return this.useCases.instance.execute();
  }
}
