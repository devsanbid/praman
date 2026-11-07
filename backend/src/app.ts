import { readFileSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { parse as parseYaml } from "yaml";
import { loadSession, requireCsrf } from "./auth";
import type { AppConfig } from "./config";
import { ApiError, isApiError } from "./errors";
import { DEMO_PASSWORD, demoDirectory } from "./demo";
import { pingLedger } from "./fabric";
import { logger } from "./logger";
import { adminRouter, publicNotice } from "./routes/adminRoutes";
import { authRouter } from "./routes/authRoutes";
import { certificateRouter } from "./routes/certificateRoutes";
import { adminInstitutionRouter, institutionRouter } from "./routes/institutionRoutes";
import { studentRouter } from "./routes/studentRoutes";
import { verifyRouter } from "./routes/verifyRoutes";

let chainCache = { at: 0, ok: false };

export function createApp(config: AppConfig): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/v1/health" } }));
  app.use(loadSession.bind(null, config));
  app.use(requireCsrf);

  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later" } },
  });
  const verifyLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again shortly" } },
  });

  app.get("/api/v1/health", async (_req, res) => {
    const now = Date.now();
    if (now - chainCache.at > 10_000) {
      chainCache = { at: now, ok: await pingLedger() };
    }
    res.json({ data: { ok: true, chainReachable: chainCache.ok } });
  });

  app.get("/api/v1/meta", async (_req, res) => {
    res.json({
      data: {
        name: "Praman",
        notice: await publicNotice(),
        limitations: [
          "Praman is a student research prototype. It is not an official system of the Government of Nepal.",
          "A matching fingerprint does not prove the legal identity of the person presenting a document.",
        ],
        demoAccounts: demoDirectory(config.ADMIN_EMAIL.toLowerCase()),
        demoPassword: DEMO_PASSWORD,
      },
    });
  });

  app.use("/api/v1/auth/login", authLimit);
  app.use("/api/v1/auth/register", authLimit);
  app.use("/api/v1/institutions/applications", authLimit);
  app.use("/api/v1/verify", verifyLimit);

  app.use("/api/v1/auth", authRouter(config));
  app.use("/api/v1/institutions", institutionRouter(config));
  app.use("/api/v1/admin/institutions", adminInstitutionRouter(config));
  app.use("/api/v1/certificates", certificateRouter(config));
  app.use("/api/v1/verify", verifyRouter(config));
  app.use("/api/v1/students", studentRouter(config));
  app.use("/api/v1/admin", adminRouter(config));

  const specPath = path.join(__dirname, "..", "openapi.yaml");
  const spec = parseYaml(readFileSync(specPath, "utf8")) as object;
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "This route does not exist" } });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === "LIMIT_FILE_SIZE";
      res.status(tooLarge ? 413 : 400).json({
        error: { code: tooLarge ? "FILE_TOO_LARGE" : "INVALID_FILE", message: tooLarge ? "The PDF exceeds the upload limit" : "The upload could not be accepted" },
      });
      return;
    }
    if (isApiError(err)) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    logger.error({ err }, "request failed");
    res.status(500).json({ error: { code: "INTERNAL", message: "The request could not be completed" } });
  };
  app.use(onError);
  return app;
}
