export const LOG_LEVELS = ["log", "warn", "debug", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogSink {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
  debug(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface Logger {
  write(level: LogLevel, message: string): void;
}

export function createLogger(sink: LogSink = console): Logger {
  return {
    write(level, message) {
      sink[level](message);
    }
  };
}
