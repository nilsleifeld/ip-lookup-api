export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function toSerializable(value: unknown): unknown {
  if (value instanceof Error) {
    const o: Record<string, string> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack) o.stack = value.stack;
    return o;
  }
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}

/**
 * One log line = one JSON object (Loki/Grafana: level and field parsing via
 * {@link https://grafana.com/docs/loki/latest/send-data/promtail/stages/json/ JSON stage}).
 */
export class Logger {
  constructor(private readonly defaults: Record<string, unknown> = {}) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger({ ...this.defaults, ...fields });
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.defaults,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        record[k] = toSerializable(v);
      }
    }
    const line = JSON.stringify(record);
    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'debug':
        console.debug(line);
        break;
      default:
        console.log(line);
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', message, fields);
  }
}
