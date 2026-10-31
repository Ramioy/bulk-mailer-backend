import { AbortExecution } from '../application/sending/abort-execution';
import type { ExecutionDependencies } from '../application/sending/execution-dependencies';
import { ExecutionEventsQuery } from '../application/sending/execution-events-query';
import { GetExecution } from '../application/sending/get-execution';
import { RecoverAfterCrash } from '../application/sending/recover-after-crash';
import { RunExecution } from '../application/sending/run-execution';
import { StartExecution } from '../application/sending/start-execution';

export interface ExecutionUseCases {
  readonly start: StartExecution;
  readonly run: RunExecution;
  readonly recover: RecoverAfterCrash;
  readonly status: GetExecution;
  readonly abort: AbortExecution;
  readonly events: ExecutionEventsQuery;
}

export function executionUseCases(deps: ExecutionDependencies): ExecutionUseCases {
  return {
    start: new StartExecution(deps),
    run: new RunExecution(deps),
    recover: new RecoverAfterCrash(deps),
    status: new GetExecution(deps),
    abort: new AbortExecution(deps),
    events: new ExecutionEventsQuery(deps),
  };
}
