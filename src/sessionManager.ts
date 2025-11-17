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

// Cache global en memoria para mapear LID -> phone (ej: 6843...@lid -> 51936809481)
const lidToPhoneCache: Record<string, string> = {};

// Archivo donde persistiremos el mapping LID -> phone
const LID_CACHE_FILE = "./lidToPhoneCache.json";

function loadLidCacheFromDisk() {
  try {
    if (fs.existsSync(LID_CACHE_FILE)) {
      const raw = fs.readFileSync(LID_CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(lidToPhoneCache, parsed);
        logger.info(
          { entries: Object.keys(lidToPhoneCache).length },
          "LID cache cargado desde disco"
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "Error cargando LID cache desde disco");
  }
}

function saveLidCacheToDisk() {
  try {
    fs.writeFileSync(
      LID_CACHE_FILE,
      JSON.stringify(lidToPhoneCache, null, 2),
      "utf8"
    );
  } catch (err) {
    logger.warn({ err }, "Error guardando LID cache en disco");
  }
}

// Cargar cache en memoria al iniciar el módulo
loadLidCacheFromDisk();

// Último PN visto en el log "bulk device migration - loading all user devices"
let lastBulkFromJid: string | null = null;   // ej: "51936809481@s.whatsapp.net"
let lastBulkPhone: string | null = null;     // ej: "51936809481"
let lastBulkSeenAt = 0;                      // timestamp (Date.now())

// Hook sobre logger.debug para capturar:
//  - mapping LID -> PN (si Baileys lo loguea)
//  - fromJid del "bulk device migration - loading all user devices"
const originalDebug = (logger as any).debug.bind(logger);

(logger as any).debug = (arg1: any, arg2?: any, ...rest: any[]) => {
  try {
    const msg = typeof arg1 === "string" ? arg1 : arg2;
    const data = typeof arg1 === "object" ? arg1 : arg2;

    // 1) LID mapping explícito (si Baileys lo loguea así)
    if (
      msg &&
      typeof msg === "string" &&
      msg.includes("LID mapping already exists, skipping") &&
      data &&
      typeof data === "object"
    ) {
      const pnUser = (data as any).pnUser;
      const lidUser = (data as any).lidUser;

      if (pnUser && lidUser) {
        const lidJid = `${lidUser}@lid`;
        lidToPhoneCache[lidJid] = pnUser;

        originalDebug(
          {
            ...data,
            lidJid,
            cachedPhone: pnUser
          },
          "LID mapping cache updated"
        );
      }
    }

    // 2) Bulk device migration: tenemos un fromJid tipo "51936809481@s.whatsapp.net"
    if (
      msg &&
      typeof msg === "string" &&
      msg.includes("bulk device migration - loading all user devices") &&
      data &&
      typeof data === "object"
    ) {
      const fromJid = (data as any).fromJid as string | undefined;

      if (fromJid) {
        // Sacamos el número normalizado a partir del fromJid (ej: 51936809481@s.whatsapp.net)
        const phoneFromBulk =
          normalizeJidToPhone(fromJid) || extractPhoneFromPnJid(fromJid);

        if (phoneFromBulk) {
          lastBulkFromJid = fromJid;
          lastBulkPhone = phoneFromBulk;
          lastBulkSeenAt = Date.now();

          originalDebug(
            {
              ...data,
              lastBulkFromJid,
              lastBulkPhone,
              lastBulkSeenAt
            },
            "Bulk device migration PN cached"
          );
        }
      }
    }
  } catch {
    // no romper el logger si algo sale mal
  }

  return originalDebug(arg1, arg2, ...rest);
};

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

// --- Helpers para distinguir y extraer datos de JID ---

function isPnJid(jid?: string | null): boolean {
  return !!jid && jid.endsWith("@s.whatsapp.net");
}

function isLidJid(jid?: string | null): boolean {
  return !!jid && jid.endsWith("@lid");
}

function extractPhoneFromPnJid(jid: string): string | null {
  if (!isPnJid(jid)) return null;
  const [user] = jid.split("@");
  if (!user) return null;

  // user puede venir como "51936809481:17"
  const base = user.split(":")[0];
  const digits = base.replace(/\D/g, "");

  if (!digits) return null;

  // Si son 9 dígitos, asumimos Perú
  if (digits.length === 9) {
    return "51" + digits;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  return null;
}

/**
 * Intenta resolver:
 *  - remoteJid "usable" (idealmente PN: 51XXXXXXXXX@s.whatsapp.net)
 *  - phone normalizado (51XXXXXXXXX) cuando sea posible
 *
 * No rompe nada si Baileys no tiene lidMapping ni campos Alt:
 * simplemente devuelve lo mismo que antes (phone puede ser null).
 */
function resolveJidAndPhone(
  session: Session,
  jidForPhone: string
): { resolvedJid: string; phone: string | null } {
  const sock = session.sock as any; // usamos "any" para acceder a campos no tipados
  let resolvedJid = jidForPhone;
  let phone: string | null = null;

  // 1) Caso fácil: JID ya es PN
  if (isPnJid(jidForPhone)) {
    resolvedJid = jidForPhone;
    phone = extractPhoneFromPnJid(jidForPhone);
    return { resolvedJid, phone };
  }

  // 2) Si es LID, intentamos buscar mapping PN
  if (isLidJid(jidForPhone)) {
    // 2.a) Primero, revisar en nuestro cache global (llenado por el logger)
    const cachedPhone = lidToPhoneCache[jidForPhone];
    if (cachedPhone) {
      resolvedJid = `${cachedPhone}@s.whatsapp.net`;
      phone = cachedPhone;
      return { resolvedJid, phone };
    }

    // 2.b) Intentar usar el mapping interno si existe (por si en algún momento lo exponen bien)
    const lidMapping = sock.signalRepository?.lidMapping;
    if (lidMapping && typeof lidMapping.getPNForLID === "function") {
      try {
        const pnJid = lidMapping.getPNForLID(jidForPhone) as string | undefined;
        if (pnJid && isPnJid(pnJid)) {
          const extracted = extractPhoneFromPnJid(pnJid);
          if (extracted) {
            // guardamos también en cache para próximos mensajes
            lidToPhoneCache[jidForPhone] = extracted;
            resolvedJid = pnJid;
            phone = extracted;
            return { resolvedJid, phone };
          }
        }
      } catch {
        // si falla, seguimos con fallback
      }
    }

    // 2.c) Fallback: no tenemos forma de sacar PN => mantenemos LID
    resolvedJid = jidForPhone;
    phone = null;
    return { resolvedJid, phone };
  }

  // 3) Otros tipos de JID (grupos, etc.) -> comportamiento similar a antes
  resolvedJid = jidForPhone;
  // Intentamos usar tu helper actual como fallback
  phone = normalizeJidToPhone(jidForPhone);
  return { resolvedJid, phone };
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

    // DEBUG ESPECIAL: si es LID, mostramos estructura del sock y del lidMapping
    if (isLidJid(remoteJid)) {
      const sockAny = session.sock as any;
      const signalRepo = sockAny?.signalRepository;
      const lidMapping = signalRepo?.lidMapping;

      let lidMappingKeys: string[] | null = null;
      let lidMappingSample: any = null;
      let pnFromMapping: string | undefined = undefined;

      if (lidMapping) {
        try {
          lidMappingKeys = Object.keys(lidMapping);
        } catch {
          lidMappingKeys = null;
        }

        if (typeof lidMapping.getPNForLID === "function") {
          try {
            pnFromMapping = lidMapping.getPNForLID(remoteJid);
          } catch {
            pnFromMapping = undefined;
          }
        }

        lidMappingSample = lidMapping;
      }

      // 1) Log estructural (como antes)
      logger.debug(
        {
          sessionId,
          remoteJid,
          sockKeys: Object.keys(sockAny || {}),
          signalRepositoryKeys: signalRepo ? Object.keys(signalRepo) : null,
          lidMappingKeys,
          pnFromMapping,
          lidMappingSample
        },
        "DEBUG LID SOCK & MAPPING"
      );

      // 2) Intento de inferir PN desde el último bulk device migration
      if (lastBulkFromJid && lastBulkPhone && lastBulkSeenAt) {
        logger.debug(
          {
            fromJid: lastBulkFromJid,
            lastBulkFromJid,
            lastBulkPhone,
            lastBulkSeenAt
          },
          "Bulk device migration PN cached"
        );

        // Por ahora asumimos que el PN obtenido del bulk es el que nos sirve para este LID
        lidToPhoneCache[remoteJid] = lastBulkPhone;

        // 🔥 Guardar cache en disco para no perderlo en reinicios
        saveLidCacheToDisk();

        logger.debug(
          {
            sessionId,
            remoteJid,
            inferredFromJid: lastBulkFromJid,
            inferredPhone: lastBulkPhone,
            lastBulkSeenAt
          },
          "LID->PN mapping inferred from bulk device migration"
        );
      }
    }

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

    // 1) JID del remitente "real" (si es grupo, usar participant; si no, remoteJid)
    const jidForPhone = participantJid || remoteJid;

    // 1.5) Si el JID es LID y tenemos un PN reciente del "bulk device migration",
    //      inferimos un mapping LID -> PN para este JID concreto.
    if (isLidJid(jidForPhone)) {
      const now = Date.now();

      // Usamos el PN del bulk solo si fue hace poco (ej. 5 segundos)
      if (
        lastBulkPhone &&
        lastBulkFromJid &&
        now - lastBulkSeenAt < 5000 && // ventana de seguridad de 5s
        !lidToPhoneCache[jidForPhone]
      ) {
        lidToPhoneCache[jidForPhone] = lastBulkPhone;

        logger.debug(
          {
            sessionId,
            remoteJid: jidForPhone,
            inferredFromJid: lastBulkFromJid,
            inferredPhone: lastBulkPhone,
            lastBulkSeenAt
          },
          "LID->PN mapping inferred from bulk device migration"
        );
      }
    }

    // 2) Resolución mejorada: intentamos PN siempre que sea posible
    const { resolvedJid, phone } = resolveJidAndPhone(session, jidForPhone);

    // 3) Identificador que usaremos como "from":
    //    - Si hay número, usamos el número
    //    - Si no hay, usamos el JID resuelto (puede ser PN o LID)
    const from = phone || resolvedJid;

    logger.info(
      { sessionId, remoteJid: resolvedJid, participantJid, phone, from, text, type },
      "Mensaje entrante recibido"
    );

    const payload = {
      event: "message",
      sessionId,
      from,                // número o JID resuelto
      phone,               // número real o null
      text,
      type,
      messageId: msg.key.id,
      remoteJid: resolvedJid,
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

  // Siempre normalizamos "to" a número y construimos un JID PN (numero@s.whatsapp.net)
  let digits = to.replace(/\D/g, ""); // dejamos solo números, venga como venga (número, +51..., JID, etc.)

  if (!digits || digits.length < 8 || digits.length > 15) {
    throw new SessionError(
      `Número de destino inválido: "${to}" -> "${digits}"`
    );
  }

  const jid = `${digits}@s.whatsapp.net`;

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

