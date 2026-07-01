import { Kafka } from 'kafkajs';

const sanitizeEnvValue = (value) => {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
};

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = sanitizeEnvValue(process.env[key]);
    if (value) return value;
  }
  return '';
};

const getBrokers = () =>
  readEnv('KAFKA_BROKERS', 'KAFKA_BOOTSTRAP_SERVERS')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);

export const getBehavioralKafkaTopic = () =>
  readEnv('KAFKA_TOPIC_VISITOR_EVENTS') || 'itm.visitor.events';

export const isKafkaConfigured = () => getBrokers().length > 0;

let kafka;
let producer;
let producerReady = false;

const getKafka = () => {
  if (kafka) return kafka;

  const username = readEnv('KAFKA_USERNAME', 'KAFKA_SASL_USERNAME');
  const password = readEnv('KAFKA_PASSWORD', 'KAFKA_SASL_PASSWORD');
  const ssl = String(readEnv('KAFKA_SSL') || '').toLowerCase() === 'true';
  const sasl = username && password
    ? {
        mechanism: readEnv('KAFKA_SASL_MECHANISM') || 'plain',
        username,
        password,
      }
    : undefined;

  kafka = new Kafka({
    clientId: readEnv('KAFKA_CLIENT_ID') || 'indiantrademart-api',
    brokers: getBrokers(),
    ssl,
    sasl,
    connectionTimeout: Number(process.env.KAFKA_CONNECTION_TIMEOUT_MS || 3000),
    requestTimeout: Number(process.env.KAFKA_REQUEST_TIMEOUT_MS || 5000),
    retry: {
      retries: Number(process.env.KAFKA_RETRIES || 2),
    },
  });

  return kafka;
};

const getProducer = async () => {
  if (!isKafkaConfigured()) return null;
  if (!producer) producer = getKafka().producer({ allowAutoTopicCreation: true });
  if (!producerReady) {
    await producer.connect();
    producerReady = true;
  }
  return producer;
};

export async function publishBehavioralEvent(event = {}) {
  if (!isKafkaConfigured()) return { published: false, reason: 'kafka_not_configured' };

  const activeProducer = await getProducer();
  if (!activeProducer) return { published: false, reason: 'producer_unavailable' };

  await activeProducer.send({
    topic: getBehavioralKafkaTopic(),
    messages: [
      {
        key: String(event.visitor_id || event.visitor_session_id || event.id || ''),
        value: JSON.stringify(event),
        headers: {
          event_type: String(event.event_type || ''),
          source: 'indiantrademart_tracking_api',
        },
      },
    ],
  });

  return { published: true };
}

export async function createBehavioralEventConsumer({ groupId, eachEvent }) {
  if (!isKafkaConfigured()) {
    throw new Error('Kafka is not configured. Set KAFKA_BROKERS or KAFKA_BOOTSTRAP_SERVERS.');
  }
  if (typeof eachEvent !== 'function') {
    throw new Error('eachEvent callback is required');
  }

  const consumer = getKafka().consumer({
    groupId: groupId || readEnv('KAFKA_CONSUMER_GROUP_ID') || 'itm-clickhouse-behavioral-consumer',
    allowAutoTopicCreation: true,
  });

  await consumer.connect();
  await consumer.subscribe({ topic: getBehavioralKafkaTopic(), fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const payload = JSON.parse(message.value.toString());
      await eachEvent(payload);
    },
  });

  return consumer;
}
