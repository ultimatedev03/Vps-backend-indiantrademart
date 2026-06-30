import { runBehavioralCommerceIntelligence } from '../lib/behavioralCommerceIntelligence.js';

const getArgValue = (name, fallback = '') => {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
};

const days = Number(getArgValue('days', '30'));

try {
  const result = await runBehavioralCommerceIntelligence({ days });
  console.log(`Behavioral Commerce Intelligence ready: ${JSON.stringify(result)}`);
  process.exit(0);
} catch (error) {
  console.error('Behavioral Commerce Intelligence failed:', error?.message || error);
  process.exit(1);
}
