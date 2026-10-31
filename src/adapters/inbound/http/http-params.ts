import { BadRequestException, ConflictException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { type Block, isBlock } from '../../../domain/block/block';
import { Period } from '../../../domain/period/period';
import { toSha256, type Sha256 } from '../../../domain/receipt/sha256';

export function periodParam(value: string): Period {
  const period = Period.parse(value);
  if (!period) throw new BadRequestException({ error: 'INVALID_PERIOD', detail: 'expected YYYY-MM' });
  return period;
}

export function blockParam(value: string): Block {
  if (!isBlock(value)) throw new BadRequestException({ error: 'INVALID_BLOCK' });
  return value;
}

export function sha256Param(value: string): Sha256 {
  try {
    return toSha256(value);
  } catch {
    throw new BadRequestException({ error: 'INVALID_SHA256' });
  }
}

const STATUS: Readonly<Record<string, new (body: object) => HttpException>> = {
  PERIOD_NOT_OPERABLE: UnprocessableEntityException,
  EXECUTION_IN_PROGRESS: ConflictException,
  RECEIPT_NOT_REMOVABLE: ConflictException,
  RECEIPT_NOT_FOUND: NotFoundException,
  BATCH_NOT_FOUND: NotFoundException,
};

/** Typed use-case errors → HTTP status with `{ error }` body. */
export function httpError(error: string): HttpException {
  const Exception = STATUS[error] ?? BadRequestException;
  return new Exception({ error });
}
