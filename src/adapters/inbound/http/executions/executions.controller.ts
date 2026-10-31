import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { ExecutionUseCases } from '../../../../composition/execution-use-cases';
import { ADAPTERS, EXECUTION_USE_CASES, SSE_HUB } from '../../../../composition/tokens';
import type { Adapters } from '../../../../composition/adapters';
import type { SseProgressHub } from '../../../outbound/sse/sse-progress-hub';
import type { StoredProgressEvent } from '../../../../ports/progress-notifier';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { blockParam, httpError, periodParam } from '../http-params';

const HEARTBEAT_MS = 15_000;

@Controller()
export class ExecutionsController {
  constructor(
    @Inject(EXECUTION_USE_CASES) private readonly useCases: ExecutionUseCases,
    @Inject(SSE_HUB) private readonly hub: SseProgressHub,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  /** "Send": body `{ manifestVersion }` = the version the operator reviewed. */
  @Post('batches/:period/:block/executions')
  @HttpCode(202)
  async start(@Param('period') period: string, @Param('block') block: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const manifestVersion = (body as { manifestVersion?: unknown } | undefined)?.manifestVersion;
    if (typeof manifestVersion !== 'number' || !Number.isInteger(manifestVersion)) {
      throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'manifestVersion' });
    }
    const result = await this.useCases.start.execute(request.operator?.username ?? 'unknown', periodParam(period), blockParam(block), manifestVersion);
    if (!result.ok) {
      const { code, ...details } = result.error;
      throw httpError(code, details);
    }
    return result.value;
  }

  /** The running execution, or the last one (D10). */
  @Get('executions/current')
  async current() {
    const status = await this.useCases.status.current();
    if (!status) throw new NotFoundException({ error: 'NO_EXECUTION' });
    return status;
  }

  @Get('executions/:executionId')
  async byId(@Param('executionId') executionId: string) {
    const status = await this.useCases.status.byId(executionId);
    if (!status) throw new NotFoundException({ error: 'EXECUTION_NOT_FOUND' });
    return status;
  }

  /**
   * D32: emergency exit for an execution that stopped making progress. Body `{ "note": "why", "force"?: true }`.
   * Refused while it showed progress in the last EXECUTION_ABORT_AFTER_MINUTES, unless forced.
   */
  @Post('executions/:executionId/abort')
  @HttpCode(200)
  async abort(@Param('executionId') executionId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const { note, force } = (body ?? {}) as { note?: unknown; force?: unknown };
    if (typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    if (force !== undefined && typeof force !== 'boolean') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'force' });
    const result = await this.useCases.abort.execute(request.operator?.username ?? 'unknown', executionId, note, force === true);
    if (!result.ok) {
      const { code, ...details } = result.error;
      throw httpError(code, details);
    }
    return result.value;
  }

  @Get('alerts')
  alerts() {
    return this.adapters.repository.alerts.list();
  }

  /**
   * Server-sent events of an execution. Resumes after `Last-Event-ID` (D11). Closes when the execution finishes
   * or when the access token expires (D12): the client renews the token and reconnects from the last id.
   */
  @Get('executions/:executionId/events')
  async events(@Param('executionId') executionId: string, @Req() request: AuthenticatedRequest, @Res() reply: FastifyReply): Promise<void> {
    const { repository, clock } = this.adapters;
    const execution = await repository.executions.get(executionId);
    if (!execution) throw new NotFoundException({ error: 'EXECUTION_NOT_FOUND' });
    const header = request.headers['last-event-id'];
    const afterSeq = Number(Array.isArray(header) ? header[0] : header) || 0;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // Node sends headers lazily; without this the client would not see the stream open until the first event.
    raw.flushHeaders();

    let lastSeq = afterSeq;
    let closed = false;
    let replaying = true;
    const buffered: StoredProgressEvent[] = [];
    const timers: NodeJS.Timeout[] = [];

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      raw.end();
    };
    const write = (stored: StoredProgressEvent) => {
      if (closed || stored.seq <= lastSeq) return;
      lastSeq = stored.seq;
      raw.write(`id: ${stored.seq}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored.event)}\n\n`);
      if (stored.event.type === 'FINISHED') close();
    };

    // Subscribe before replaying, so nothing published meanwhile is lost; duplicates are skipped by seq.
    const unsubscribe = this.hub.subscribe(executionId, (stored) => (replaying ? buffered.push(stored) : write(stored)));
    for (const stored of await repository.executionEvents.listAfter(executionId, afterSeq)) write(stored);
    replaying = false;
    for (const stored of buffered) write(stored);
    if (closed) return;

    if ((await repository.executions.get(executionId))?.finishedAt) {
      close();
      return;
    }
    const expiresInMs = Math.max(0, (request.operator?.accessExpiresAt.getTime() ?? 0) - clock.now().getTime());
    timers.push(
      setTimeout(() => {
        if (!closed) raw.write('event: TOKEN_EXPIRED\ndata: {}\n\n');
        close();
      }, expiresInMs),
    );
    const heartbeat = setInterval(() => !closed && raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
    timers.push(heartbeat);
    raw.on('close', close);
  }
}
