import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ReceiptUseCases } from '../../../../composition/receipt-use-cases';
import { RECEIPT_USE_CASES } from '../../../../composition/tokens';
import type { UploadedFile } from '../../../../application/receipts/upload-receipts';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { blockParam, httpError, periodParam, sha256Param } from '../http-params';

const actor = (request: AuthenticatedRequest) => request.operator?.username ?? 'unknown';

@Controller()
export class ReceiptsController {
  constructor(@Inject(RECEIPT_USE_CASES) private readonly useCases: ReceiptUseCases) {}

  /** multipart/form-data with one or more `files` parts. */
  @Post('batches/:period/:block/receipts')
  @HttpCode(200)
  async upload(@Param('period') period: string, @Param('block') block: string, @Req() request: AuthenticatedRequest) {
    const p = periodParam(period);
    const b = blockParam(block);
    const files = await readFiles(request);
    if (files.length === 0) throw new BadRequestException({ error: 'NO_FILES' });
    const result = await this.useCases.upload.execute(actor(request), p, b, files);
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  @Get('batches/:period/:block')
  summary(@Param('period') period: string, @Param('block') block: string, @Req() request: AuthenticatedRequest) {
    return this.useCases.summary.execute(actor(request), periodParam(period), blockParam(block));
  }

  @Post('batches/:period/:block/refresh-recipients')
  @HttpCode(200)
  async refresh(@Param('period') period: string, @Param('block') block: string, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.refresh.execute(actor(request), periodParam(period), blockParam(block));
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  /** D31: `{ "fileName": "<one of the names in conflict>", "note": "why" }`. Removing the receipt is the other way out. */
  @Post('receipts/:sha256/resolve-conflict')
  @HttpCode(200)
  async resolveConflict(@Param('sha256') sha256: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const fileName = (body as Record<string, unknown> | undefined)?.fileName;
    const note = (body as Record<string, unknown> | undefined)?.note;
    if (typeof fileName !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'fileName' });
    if (typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.resolveConflict.execute(actor(request), sha256Param(sha256), fileName, note);
    if (!result.ok) {
      const { code, ...details } = result.error;
      throw httpError(code, details);
    }
    return result.value;
  }

  @Delete('receipts/:sha256')
  @HttpCode(200)
  async remove(@Param('sha256') sha256: string, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.remove.execute(actor(request), sha256Param(sha256));
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }
}

async function readFiles(request: FastifyRequest): Promise<UploadedFile[]> {
  if (!request.isMultipart()) throw new BadRequestException({ error: 'EXPECTED_MULTIPART' });
  const files: UploadedFile[] = [];
  for await (const part of request.parts()) {
    if (part.type !== 'file') continue;
    const content = await part.toBuffer();
    // The transport stops reading at the size limit, before the whole file is in memory.
    files.push({ name: part.filename, content: new Uint8Array(content), tooLarge: part.file.truncated });
  }
  return files;
}
