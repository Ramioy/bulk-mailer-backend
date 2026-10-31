import { BadGatewayException, BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

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
  BATCH_NOT_EXECUTABLE: ConflictException,
  MANIFEST_CHANGED: ConflictException,
  NOTHING_TO_SEND: ConflictException,
  ARCHIVE_COPY_NOT_CONFIGURED: ConflictException,
  RECEIPT_NOT_UNCERTAIN: ConflictException,
  RECEIPT_NOT_VERIFIABLE: ConflictException,
  RECEIPT_NOT_RESENDABLE: ConflictException,
  FILE_NOT_AVAILABLE: ConflictException,
  FILE_MODIFIED: ConflictException,
  EMAIL_SUPPRESSED: ConflictException,
  CONTRACT_NOT_FOUND: UnprocessableEntityException,
  CONTRACT_INACTIVE: UnprocessableEntityException,
  CONTRACT_WITHOUT_EMAIL: UnprocessableEntityException,
  SOURCE_UNAVAILABLE: ServiceUnavailableException,
  ADDRESS_NOT_SUPPRESSED: NotFoundException,
  BUSINESS_CONFIRMATION_REQUIRED: UnprocessableEntityException,
  PROVIDER_REMOVAL_NOT_CONFIRMED: UnprocessableEntityException,
  SUPPRESSION_PROVIDER_FAILED: BadGatewayException,
  CONCEPT_NOT_FOUND: NotFoundException,
  CONCEPT_ALREADY_EXISTS: ConflictException,
  INVALID_CONCEPT_KEY: UnprocessableEntityException,
  INVALID_CONCEPT_SUBJECT: UnprocessableEntityException,
  RECEIPT_NOT_IN_CONFLICT: ConflictException,
  NAME_NOT_IN_CONFLICT: UnprocessableEntityException,
  CHOSEN_NAME_INVALID: UnprocessableEntityException,
};

/** Typed use-case errors → HTTP status with `{ error, ...details }` body. */
export function httpError(error: string, details: object = {}): HttpException {
  const Exception = STATUS[error] ?? BadRequestException;
  return new Exception({ error, ...details });
}
