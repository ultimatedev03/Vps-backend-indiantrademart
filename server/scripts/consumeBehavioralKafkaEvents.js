import '../lib/runtimeConfig.js';
import { createBehavioralEventConsumer, getBehavioralKafkaTopic, isKafkaConfigured } from '../lib/kafkaAnalytics.js';
import { setupClickHouseBehavioralSchema, writeClickHouseEvents, isClickHouseConfigured } from '../lib/clickHouseAnalytics.js';

const batchSizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const flushMsArg = process.argv.find((arg) => arg.startsWith('--flush-ms='));
const batchSize = Math.min(Math.max(Number(batchSizeArg?.split('=')[1]) || 100, 1), 1000);
const flushMs = Math.min(Math.max(Number(flushMsArg?.split('=')[1]) || 5000, 1000), 60000);

if (!isKafkaConfigured()) {
  console.error('Kafka is not configured. Set KAFKA_BROKERS.');
  process.exit(1);
}

if (!isClickHouseConfigured()) {
  console.error('ClickHouse is not configured. Set CLICKHOUSE_URL.');
  process.exit(1);
}

await setupClickHouseBehavioralSchema();

let buffer = [];
let flushing = false;

const flush = async () => {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer.splice(0, batchSize);
  try {
    const result = await writeClickHouseEvents(batch);
    console.log(`Kafka -> ClickHouse: ${result.inserted || 0} events inserted`);
  } catch (error) {
    console.error('Kafka -> ClickHouse flush failed:', error?.message || error);
    buffer = [...batch, ...buffer].slice(0, batchSize * 10);
  } finally {
    flushing = false;
  }
};

setInterval(flush, flushMs).unref();

const consumer = await createBehavioralEventConsumer({
  eachEvent: async (event) => {
    buffer.push(event);
    if (buffer.length >= batchSize) await flush();
  },
});

console.log(`Behavioral Kafka consumer running on topic ${getBehavioralKafkaTopic()} (batch=${batchSize}, flushMs=${flushMs})`);

const shutdown = async () => {
  await flush();
  await consumer.disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
