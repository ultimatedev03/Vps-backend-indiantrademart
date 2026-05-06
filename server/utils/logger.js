/**
 * Server-side logger.
 * - logger.log / logger.warn  → only emit in development (NODE_ENV !== 'production')
 * - logger.error              → always emits (errors are always useful)
 */
const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  // eslint-disable-next-line no-console
  log: (...args) => { if (isDev) console.log(...args); },
  // eslint-disable-next-line no-console
  warn: (...args) => { if (isDev) console.warn(...args); },
  // eslint-disable-next-line no-console
  error: (...args) => console.error(...args),
};
