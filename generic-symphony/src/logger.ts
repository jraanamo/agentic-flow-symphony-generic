type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private context: Record<string, unknown>;

  constructor(context: Record<string, unknown> = {}) {
    this.context = context;
  }

  child(extra: Record<string, unknown>): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.emit('debug', event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.emit('error', event, fields);
  }

  private emit(level: Level, event: string, fields?: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.context,
      ...fields,
    };
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

export const logger = new Logger({ service: 'symphony' });
