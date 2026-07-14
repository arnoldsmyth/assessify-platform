// BullMQ processors land with A5 (asy-aq5.5). Processors stay thin:
// parse job → call service. This entrypoint proves the worker → service wiring.
import { getHealth } from '@assessify/services';

const result = getHealth();
if (result.ok) {
  console.log(`[worker] service layer reachable at ${result.value.timestamp}`);
} else {
  console.error(`[worker] health check failed: ${result.error.code}`);
  process.exit(1);
}
