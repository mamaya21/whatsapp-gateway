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

function normalizeJidToPhone(jid?: string | null): string | null {
  if (!jid) return null;

  const [userPart, serverPart] = jid.split("@"); // ej: "38336894881995", "lid"

  // Si es un JID tipo LID, no lo tratamos como teléfono
  if (serverPart === "lid") {
    return null;                 // 👈 CLAVE: aquí decimos “no hay teléfono”
  }

  // Ej normales: s.whatsapp.net, c.us
  let base = userPart.split(":")[0];   // p.ej "51936809481:17" -> "51936809481"

  let digits = base.replace(/\D/g, "");

  if (!digits) return null;

  // Si son 9 dígitos, asumimos celular Perú
  if (digits.length === 9) {
    digits = "51" + digits;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  return null;
}

function normalizePhoneToJid(phone: string): string {
  // Quitamos cualquier cosa que no sea número (espacios, +, guiones, etc.)
  let digits = phone.replace(/\D/g, "");

  if (digits.length === 9) {
    // Celular sin código de país -> asumimos Perú
    digits = "51" + digits;
  }

  // En este punto digits debería ser algo tipo 51936809481
  return `${digits}@s.whatsapp.net`;
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
    logger.debug({ sessionId, status: existing.status }, "Sesión ya existente");

    // Actualizamos el webhook si cambió
    if (webhookUrl && existing.webhookUrl !== webhookUrl) {
      existing.webhookUrl = webhookUrl;
      existing.updatedAt = new Date();
    }

    // Si la sesión está activa o en proceso de conexión, solo la devolvemos
    if (
      existing.status === "online" ||
      existing.status === "qr" ||
      existing.status === "starting"
    ) {
      logger.debug({ sessionId, status: existing.status }, "Sesión activa, se reutiliza");
      return existing;
    }

    // Si llega aquí, la sesión existe pero está caída (disconnected / error)
    logger.info(
      { sessionId, status: existing.status },
      "Sesión existente pero no activa, se recreará el socket"
    );

    // Cerramos el socket anterior por seguridad
    try {
      existing.sock.end(new Error("Reiniciando sesión caída"));
    } catch (err) {
      logger.warn({ sessionId, err }, "Error al cerrar socket previo al reinicio");
    }

    // IMPORTANTE: no hacemos return -> dejamos que continúe la función
    // y cree un nuevo sock con las mismas credenciales de ./sessions/<sessionId>
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
    const remoteJid = msg.key.remoteJid;
    const participantJid = msg.key.participant || null; // útil para grupos
    const isFromMe = msg.key.fromMe;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.conversation ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
      "";

    if (!remoteJid) continue;

    if (isFromMe) {
      logger.debug(
        { sessionId, remoteJid },
        "Mensaje enviado por nosotros, se ignora"
      );
      continue;
    }

    if (!text.trim()) {
      logger.debug(
        { sessionId, remoteJid },
        "Mensaje sin texto útil, se ignora"
      );
      continue;
    }

    // 1) JID del remitente "real"
    const jidForPhone = participantJid || remoteJid;

    // 2) Intentamos obtener número (será null para @lid)
    const phone = normalizeJidToPhone(jidForPhone);

    // 3) Identificador que usaremos como "from":
    //    - Si hay número, usamos el número
    //    - Si no hay, usamos el JID tal cual (ej: 3833...@lid)
    const from = phone || jidForPhone;

    logger.info(
      { sessionId, remoteJid, participantJid, phone, from, text, type },
      "Mensaje entrante recibido"
    );

    const payload = {
      event: "message",
      sessionId,
      from,              // puede ser número o JID (para @lid)
      phone,             // número real o null
      text,
      type,
      messageId: msg.key.id,
      remoteJid,
      participantJid,
      timestamp: new Date().toISOString()
    };

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

  if (!text || !text.trim()) {
    throw new SessionError("Texto del mensaje vacío o inválido.");
  }

  // --- NUEVO: aceptar número o JID ---
  let jid: string;

  if (to.includes("@")) {
    // Caso 1: n8n te envía directamente el JID (sirve para @s.whatsapp.net, @c.us, @lid, etc.)
    jid = to;
  } else {
    // Caso 2: n8n te envía un número (con o sin +, espacios, etc.)
    let digits = to.replace(/\D/g, ""); // dejamos solo números

    if (!digits || digits.length < 8 || digits.length > 15) {
      throw new SessionError(
        `Número de destino inválido: "${to}" -> "${digits}"`
      );
    }

    jid = `${digits}@s.whatsapp.net`;
  }
  // --- FIN NUEVO ---

  try {
    const res = await session.sock.sendMessage(jid, { text });

    logger.info(
      { sessionId, to, jid, text },
      "Mensaje enviado correctamente"
    );

    return res;
  } catch (error: any) {
    logger.error({ sessionId, to, jid, err: error }, "Error al enviar mensaje");
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

