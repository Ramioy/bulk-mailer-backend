import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, PayloadTooLargeException, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ReceiptUseCases } from '../../../../composition/receipt-use-cases';
import { RECEIPT_USE_CASES } from '../../../../composition/tokens';
import type { UploadedFile, UploadReceipts } from '../../../../application/receipts/upload-receipts';
import { APP_CONFIG, type AppConfig } from '../../../../config/app-config';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { blockParam, httpError, periodParam, sha256Param } from '../http-params';

const actor = (request: AuthenticatedRequest) => request.operator?.username ?? 'unknown';

@Controller()
export class ReceiptsController {
  constructor(
    @Inject(RECEIPT_USE_CASES) private readonly useCases: ReceiptUseCases,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * multipart/form-data with one or more `files` parts. D48: each part is staged on the volume as it arrives (hashed on
   * the way), so the request is never held in memory; over UPLOAD_MAX_TOTAL_BYTES or UPLOAD_MAX_FILES it is answered
   * 413 UPLOAD_TOO_LARGE, its staged files are dropped and the connection is closed instead of reading the rest.
   */
  @Post('batches/:period/:block/receipts')
  @HttpCode(200)
  async upload(@Param('period') period: string, @Param('block') block: string, @Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const p = periodParam(period);
    const b = blockParam(block);
    const files = await readFiles(request, reply, this.useCases.upload, { maxTotalBytes: this.config.uploadMaxTotalBytes, maxFiles: this.config.uploadMaxFiles });
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

  /** D51: `{ "note": "why" }`. Releases the files of the batch's receipts (not of those being sent); the records stay. */
  @Post('batches/:period/:block/release-files')
  @HttpCode(200)
  async releaseFiles(@Param('period') period: string, @Param('block') block: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const note = (body as Record<string, unknown> | undefined)?.note;
    if (typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.releaseFiles.execute(actor(request), periodParam(period), blockParam(block), note);
    if (!result.ok) throw httpError(result.error);
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

class UploadBudgetExceeded extends Error {}

async function readFiles(
  request: FastifyRequest,
  reply: FastifyReply,
  upload: Pick<UploadReceipts, 'stage' | 'discard'>,
  limits: { readonly maxTotalBytes: number; readonly maxFiles: number },
): Promise<UploadedFile[]> {
  if (!request.isMultipart()) throw new BadRequestException({ error: 'EXPECTED_MULTIPART' });
  const files: UploadedFile[] = [];
  let total = 0;
  // Counts the bytes of every part as they stream into the staging area; past the budget the stream fails.
  async function* counted(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > limits.maxTotalBytes) throw new UploadBudgetExceeded();
      yield chunk;
    }
  }
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      const staged = await upload.stage(counted(part.file));
      // The transport stops reading at the per-file size limit; such a file is reported REJECTED, not stored.
      files.push({ name: part.filename, staged, tooLarge: part.file.truncated });
    }
  } catch (error) {
    await upload.discard(files);
    const filesLimit = (error as { code?: unknown }).code === 'FST_FILES_LIMIT';
    if (!(error instanceof UploadBudgetExceeded) && !filesLimit) throw error;
    // The rest of the body is not read: the connection is closed after the answer.
    reply.header('connection', 'close');
    throw new PayloadTooLargeException({ error: 'UPLOAD_TOO_LARGE', maxTotalBytes: limits.maxTotalBytes, maxFiles: limits.maxFiles });
  }
  return files;
}
