import makeWASocket, {
  useMultiFileAuthState,
  WASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BaileysEventMap
} from "@whiskeysockets/baileys";
import { logger } from "./logger";
import qrcode from "qrcode-terminal";
import fs from "fs";
import axios from "axios";

export type SessionStatus = "starting" | "qr" | "online" | "disconnected" | "error";

export interface Session {
  sessionId: string;
  status: SessionStatus;
  sock: WASocket;
  webhookUrl?: string;
  lastQr?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessions: Record<string, Session> = {};

async function sendWebhook(session: Session, payload: unknown) {
  if (!session.webhookUrl) return;

  try {
    await axios.post(session.webhookUrl, payload, {
      timeout: 5000,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.sessionId },
      "Error enviando webhook a n8n"
    );
  }
}

export function getSessions(): Session[] {
  return Object.values(sessions);
}

export function getSession(sessionId: string): Session | null {
  return sessions[sessionId] || null;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export async function startSession(sessionId: string, webhookUrl?: string): Promise<Session> {
  if (!sessionId || !/^[a-zA-Z0-9_\-]+$/.test(sessionId)) {
    throw new SessionError("sessionId inválido (solo letras, números, guiones y guion bajo)");
  }

  const existing = sessions[sessionId];
  if (existing) {
    logger.debug({ sessionId }, "Sesión ya existente, devolviendo instancia");
    if (webhookUrl && existing.webhookUrl !== webhookUrl) {
      existing.webhookUrl = webhookUrl;
      existing.updatedAt = new Date();
    }
    return existing;
  }

  logger.info({ sessionId }, "Iniciando nueva sesión...");

  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger
    });

    const session: Session = {
      sessionId,
      status: "starting",
      sock,
      webhookUrl,
      lastQr: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    sessions[sessionId] = session;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      handleConnectionUpdate(session, update);
    });

    sock.ev.on("messages.upsert", (m) => {
      handleMessagesUpsert(session, m);
    });

    return session;
  } catch (error: any) {
    logger.error({ sessionId, err: error }, "Error al iniciar sesión");
    throw new SessionError(`No se pudo iniciar la sesión ${sessionId}: ${error?.message || error}`);
  }
}

function handleConnectionUpdate(
  session: Session,
  update: Partial<BaileysEventMap["connection.update"]>
) {
  const { connection, lastDisconnect, qr } = update;
  const { sessionId } = session;

  if (qr) {
    logger.info({ sessionId }, "Nuevo QR generado");
    session.status = "qr";
    session.lastQr = qr;
    session.updatedAt = new Date();

    // En desarrollo mostramos el QR en consola
    if (process.env.NODE_ENV !== "production") {
      qrcode.generate(qr, { small: true });
    }
  }

  if (connection === "open") {
    logger.info({ sessionId }, "Conexión abierta (online)");
    session.status = "online";
    session.lastQr = null;
    session.updatedAt = new Date();
  }

  if (connection === "close") {
    // Puede venir como statusCode o como code simple
    const rawError: any = lastDisconnect?.error;
    const statusCode =
      rawError?.output?.statusCode ?? rawError?.code ?? undefined;

    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
    const isRestartRequired = statusCode === 515; // stream:error 515 después de emparejar
    const shouldReconnect = !isLoggedOut && !isRestartRequired;

    logger.warn(
      { sessionId, statusCode, isLoggedOut, isRestartRequired, shouldReconnect },
      "Conexión cerrada"
    );

    session.status = "disconnected";
    session.updatedAt = new Date();

    if (isRestartRequired) {
      logger.info(
        { sessionId, statusCode },
        "Cierre por 515 (restart required tras emparejar). Forzando reinicio de la sesión..."
      );

      // Cerramos el socket previo
      try {
        session.sock.end(new Error("Restart required after pairing"));
      } catch {}

      // Eliminamos la instancia en memoria
      delete sessions[sessionId];

      // Volvemos a iniciar la sesión desde cero (pero manteniendo creds)
      startSession(sessionId, session.webhookUrl).catch((err) => {
        logger.error({ sessionId, err }, "Error al reiniciar sesión tras 515");
        session.status = "error";
      });

      return;
    }

    if (shouldReconnect) {
      // Errores de red u otros: intentamos recrear la sesión
      startSession(sessionId, session.webhookUrl).catch((err) => {
        logger.error({ sessionId, err }, "Error al intentar reconectar la sesión");
        session.status = "error";
      });
    } else if (isLoggedOut) {
      logger.warn(
        { sessionId },
        "Sesión cerrada por logout, se requiere nuevo QR. Limpiando datos de sesión..."
      );
      clearSession(sessionId);

      // Opcional: volver a iniciar automáticamente la sesión
      startSession(sessionId, session.webhookUrl).catch((err) => {
        logger.error({ sessionId, err }, "Error al reiniciar sesión luego de logout");
      });
    }
  }
}


function handleMessagesUpsert(
  session: Session,
  m: BaileysEventMap["messages.upsert"]
) {
  const { sessionId } = session;
  const { type, messages } = m;

  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    const fromJid = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.conversation ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
      "";

    if (!fromJid) continue;

    if (isFromMe) {
      logger.debug({ sessionId, fromJid }, "Mensaje enviado por nosotros, se ignora");
      continue;
    }

    if (!text.trim()) {
      logger.debug({ sessionId, fromJid }, "Mensaje sin texto útil, se ignora");
      continue;
    }

    logger.info(
      { sessionId, fromJid, text, type },
      "Mensaje entrante recibido"
    );

    // FUTURO: aquí llamarías al webhook de n8n si session.webhookUrl existe
    const cleanFrom = fromJid.split("@")[0];

    const payload = {
      event: "message",
      sessionId,
      from: cleanFrom,
      text,
      type,
      messageId: msg.key.id,
      timestamp: new Date().toISOString()
    };

    // NO usamos await. NO cambiamos async. NO bloqueamos tu código.
    sendWebhook(session, payload);
  }
}

export async function sendMessageFromSession(
  sessionId: string,
  to: string,
  text: string
) {
  const session = sessions[sessionId];
  if (!session) {
    throw new SessionError(`Sesión ${sessionId} no existe`);
  }

  if (session.status !== "online") {
    throw new SessionError(
      `Sesión ${sessionId} no está online, estado actual: ${session.status}`
    );
  }

  if (!to || !/^\d{8,15}$/.test(to)) {
    throw new SessionError("Número de destino inválido. Usa solo dígitos con código de país.");
  }

  if (!text || !text.trim()) {
    throw new SessionError("Texto del mensaje vacío o inválido.");
  }

  try {
    const jid = `${to}@s.whatsapp.net`;

    const res = await session.sock.sendMessage(jid, { text });

    logger.info(
      { sessionId, to, text },
      "Mensaje enviado correctamente"
    );

    return res;
  } catch (error: any) {
    logger.error({ sessionId, to, err: error }, "Error al enviar mensaje");
    throw new SessionError(
      `Error al enviar mensaje desde la sesión ${sessionId}: ${error?.message || error}`
    );
  }
}

export function clearSession(sessionId: string): void {
  const session = sessions[sessionId];

  // 1. Cerrar el socket si existe
  if (session) {
    try {
      session.sock.end(new Error("Sesión destruida manualmente"));
    } catch (err) {
      logger.warn({ sessionId, err }, "Error al cerrar socket al limpiar sesión");
    }

    delete sessions[sessionId];
    logger.info({ sessionId }, "Sesión eliminada de memoria");
  }

  // 2. Borrar la carpeta de credenciales de Baileys
  const folderPath = `./sessions/${sessionId}`;
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info({ sessionId, folderPath }, "Carpeta de sesión eliminada del disco");
    }
  } catch (err) {
    logger.warn({ sessionId, folderPath, err }, "Error al intentar borrar carpeta de sesión");
  }
}

