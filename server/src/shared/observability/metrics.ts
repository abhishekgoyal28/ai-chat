import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics, served on /metrics by every service. One registry per
 * process; the `service` label tells the three services apart when they
 * share a scrape config.
 */
export const metricsRegistry = new Registry();

export const initMetrics = (service: string): void => {
  metricsRegistry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: metricsRegistry });
};

const MS_BUCKETS = [25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];

export const metrics = {
  llmLatencyMs: new Histogram({
    name: 'aic_llm_request_duration_ms',
    help: 'Wall time of one model call.',
    labelNames: ['provider_kind', 'model', 'kind', 'status'],
    buckets: MS_BUCKETS,
    registers: [metricsRegistry],
  }),
  llmTokens: new Counter({
    name: 'aic_llm_tokens_total',
    help: 'Tokens reported by providers.',
    labelNames: ['provider_kind', 'model', 'direction'],
    registers: [metricsRegistry],
  }),
  generations: new Counter({
    name: 'aic_generations_total',
    help: 'Generation results by kind and status.',
    labelNames: ['kind', 'status', 'failure_reason'],
    registers: [metricsRegistry],
  }),
  turnFirstPartMs: new Histogram({
    name: 'aic_turn_first_part_ms',
    help: 'Server receipt of a user turn to its first reply part being published.',
    buckets: MS_BUCKETS,
    registers: [metricsRegistry],
  }),
  partsPublished: new Counter({
    name: 'aic_parts_published_total',
    help: 'Reply parts revealed, by delivery path.',
    labelNames: ['delivery'],
    registers: [metricsRegistry],
  }),
  turnsReceived: new Counter({
    name: 'aic_turns_received_total',
    help: 'User turns persisted, and turns rejected by reason.',
    labelNames: ['outcome'],
    registers: [metricsRegistry],
  }),
  sessions: new Counter({
    name: 'aic_sessions_total',
    help: 'Conversations created and ended.',
    labelNames: ['event', 'reason'],
    registers: [metricsRegistry],
  }),
  socketConnections: new Counter({
    name: 'aic_socket_connections_total',
    help: 'Socket handshakes by outcome.',
    labelNames: ['outcome'],
    registers: [metricsRegistry],
  }),
  webhookDeliveries: new Counter({
    name: 'aic_webhook_deliveries_total',
    help: 'Host webhook deliveries by event and outcome.',
    labelNames: ['event', 'outcome'],
    registers: [metricsRegistry],
  }),
};
