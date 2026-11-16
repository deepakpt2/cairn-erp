/**
 * SMTP transport — the only file that imports the mail library.
 *
 * Nothing here reads the database. A caller hands in a decrypted config, the config lives for the
 * length of one call, and every error leaves this file as a MailTransportError whose text is built
 * from the library's `code` and the server's own reply — never from the options object, which
 * carries the password.
 */
import nodemailer from 'nodemailer';

export type MailEncryption = 'STARTTLS' | 'TLS' | 'NONE';

export interface MailTransportConfig {
  host: string;
  port: number;
  encryption: MailEncryption;
  username: string | null;
  /** Decrypted at the point of use. Never stored, logged or returned. */
  password: string | null;
  senderAddress: string;
  senderName: string | null;
}

export interface MailAttachment {
  name: string;
  mime: string;
  base64: string;
}

/** All four timeouts stay below the MAIL.SEND job's timeout_seconds (120). */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** The only error type that escapes this file. `message` is safe to store and display. */
export class MailTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailTransportError';
  }
}

function build(cfg: MailTransportConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.encryption === 'TLS',
    requireTLS: cfg.encryption === 'STARTTLS',
    ...(cfg.username !== null ? { auth: { user: cfg.username, pass: cfg.password ?? '' } } : {}),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true },
  });
}

/** Reduce any thrown value to `CODE` and, for an SMTP rejection, the first 200 characters of the reply. */
function sanitise(err: unknown): MailTransportError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; response?: unknown };
  const code = typeof e.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : 'MAIL_TRANSPORT_FAILED';
  const response = typeof e.response === 'string' ? e.response.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return new MailTransportError(response ? `${code}: ${response}` : code);
}

export async function deliverMail(
  cfg: MailTransportConfig,
  message: { to: string; subject: string; text: string; attachment?: MailAttachment | null },
): Promise<void> {
  const transport = build(cfg);
  try {
    await transport.sendMail({
      from: cfg.senderName ? { name: cfg.senderName, address: cfg.senderAddress } : cfg.senderAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.attachment
        ? {
            attachments: [
              { filename: message.attachment.name, contentType: message.attachment.mime, content: message.attachment.base64, encoding: 'base64' as const },
            ],
          }
        : {}),
    });
  } catch (err) {
    throw sanitise(err);
  } finally {
    transport.close();
  }
}

export async function probeConnection(cfg: MailTransportConfig): Promise<void> {
  const transport = build(cfg);
  try {
    await transport.verify();
  } catch (err) {
    throw sanitise(err);
  } finally {
    transport.close();
  }
}
