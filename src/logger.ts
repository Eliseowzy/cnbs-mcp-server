import path from 'node:path';
import pino, { type LoggerOptions } from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const baseOptions: LoggerOptions = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid, service: 'cnbs-mcp-server' },
  serializers: { err: pino.stdSerializers.err },
  redact: {
    paths: ['authorization', 'req.headers.authorization', 'token', '*.token'],
    censor: '[REDACTED]',
  },
};

export const logger = process.env.NODE_ENV === 'test'
  ? pino({ ...baseOptions, level: 'silent' })
  : pino(baseOptions, pino.transport({
      targets: [
        {
          target: 'pino-roll',
          level,
          options: {
            file: path.join(process.env.LOG_DIR || path.resolve(process.cwd(), 'logs'), 'app'),
            frequency: 'daily',
            size: '10m',
            limit: { count: 14 },
            mkdir: true,
            dateFormat: 'yyyy-MM-dd',
            extension: '.log',
          },
        },
        { target: 'pino/file', level, options: { destination: 1 } },
      ],
    }));

export const createLogger = (module: string) => logger.child({ module });
