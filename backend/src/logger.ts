import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-csrf-token']", "res.headers.set-cookie", "res.headers['set-cookie']", "password", "passwordHash", "*.key", "*.cert"],
    remove: true,
  },
});
