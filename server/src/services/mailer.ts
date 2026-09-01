import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "../env.js";
import pino from "pino";

const logger = pino({ name: "mailer" });

interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | null = null;
let resendClient: Resend | null = null;

function getSmtpTransport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return smtpTransport;
}

function getResendClient() {
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

export async function sendMail(message: MailMessage): Promise<void> {
  switch (env.MAIL_PROVIDER) {
    case "smtp":
      await getSmtpTransport().sendMail({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return;
    case "resend":
      await getResendClient().emails.send({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      return;
    case "none":
      logger.warn({ message }, "MAIL_PROVIDER=none, skipping send (would have sent this email)");
      return;
  }
}
