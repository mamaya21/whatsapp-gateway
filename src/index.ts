import express, { NextFunction, Request, Response } from "express";
import QRCode from "qrcode"; 
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  startSession,
  getSessions,
  getSession,
  sendMessageFromSession,
  clearSession,
  SessionError
} from "./sessionManager";
import { logger } from "./logger";

dotenv.config();

const app = express();

// Seguridad básica
app.use(helmet());

// CORS (en dev usamos *, en prod se restringe)
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// Rate limit básico para evitar abuso
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 120, // 120 requests / min
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return res.status(429).json({
      error: "Demasiadas peticiones. Intenta nuevamente en unos segundos."
    });
  }
});
app.use(apiLimiter);

// Body parser
app.use(express.json());

// const PORT = process.env.PORT || 3000;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Schemas de validación
const StartSessionSchema = z.object({
  webhookUrl: z.string().url().optional()
});

const SendMessageSchema = z.object({
  to: z.string().min(8),
  text: z.string().min(1)
});

// Endpoint de salud
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "WhatsApp Gateway Baileys ON (dev)" });
});

// Crear / iniciar sesión
app.post("/sessions/:sessionId/start", async (req, res, next) => {
  const sessionId = req.params.sessionId;
  const parseResult = StartSessionSchema.safeParse(req.body || {});

  if (!parseResult.success) {
    return res.status(400).json({ error: "Body inválido", details: parseResult.error.issues });
  }

  const { webhookUrl } = parseResult.data;

  try {
    const session = await startSession(sessionId, webhookUrl);
    res.json({
      sessionId: session.sessionId,
      status: session.status,
      hasQr: !!session.lastQr
    });
  } catch (err) {
    next(err);
  }
});

// Obtener detalle de una sesión (para panel futuro)
app.get("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Sesión no encontrada" });
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    hasQr: !!session.lastQr,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  });
});

// Obtener último QR (si existe)
app.get("/sessions/:sessionId/qr", (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Sesión no encontrada" });
  }

  res.json({
    sessionId,
    status: session.status,
    qr: session.lastQr ?? null
  });
});

// Listar sesiones
app.get("/sessions", (_req, res) => {
  res.json(
    getSessions().map((s) => ({
      sessionId: s.sessionId,
      status: s.status
    }))
  );
});

// Enviar mensaje desde una sesión
app.post("/sessions/:sessionId/sendMessage", async (req, res, next) => {
  const { sessionId } = req.params;
  const parseResult = SendMessageSchema.safeParse(req.body || {});

  if (!parseResult.success) {
    return res.status(400).json({ error: "Body inválido", details: parseResult.error.issues });
  }

  const { to, text } = parseResult.data;

  try {
    const result = await sendMessageFromSession(sessionId, to, text);
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// Logout / limpiar sesión
app.post("/sessions/:sessionId/logout", (req, res) => {
  const { sessionId } = req.params;
  const existing = getSession(sessionId);
  if (!existing) {
    return res.status(404).json({ error: "Sesión no encontrada" });
  }

  clearSession(sessionId);
  res.json({ ok: true, message: `Sesión ${sessionId} eliminada` });
});

// Middleware de manejo de errores
app.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SessionError) {
      logger.warn({ err: err.message }, "Error de sesión controlado");
      return res.status(400).json({ error: err.message });
    }

    logger.error({ err }, "Error inesperado en el servidor");

    return res.status(500).json({
      error: "Error interno del servidor"
    });
  }
);

// app.listen(PORT, () => {
//   logger.info(`🚀 WhatsApp Gateway corriendo en http://localhost:${PORT}`);
// });

app.listen(PORT, HOST, () => {
  logger.info(`🚀 WhatsApp Gateway corriendo en http://${HOST}:${PORT}`);
});

app.get(
  "/sessions/:sessionId/qr-image",
  async (req: Request, res: Response, next: NextFunction) => {
    const { sessionId } = req.params;

    try {
      const session = getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `No existe la sesión '${sessionId}'.`
        });
      }

      if (!session.lastQr) {
        return res.status(400).json({
          error: "QR_NOT_AVAILABLE",
          message:
            "La sesión no tiene un QR disponible (puede estar ya conectada o aún no se generó el QR)."
        });
      }

      // Generar PNG desde el texto QR
      const buffer = await QRCode.toBuffer(session.lastQr, {
        type: "png",
        width: 300
      });

      res.setHeader("Content-Type", "image/png");
      res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  }
);
