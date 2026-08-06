import { env } from "@petrel/config";
import { logger } from "@petrel/logger";
import nodemailer from "nodemailer";

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(input: MailInput): Promise<void>;
}

/**
 * 邮件通道：console（开发/测试，邮件打到日志含完整链接）或 SMTP（生产）。
 *
 * 「零第三方认证依赖」只约束密码哈希与 JWT（见 auth 设计文档 §2），
 * 邮件发送不在其列；SMTP 与具体服务商解耦，换商只改配置。
 */
export function createMailer(): Mailer {
  if (env.mail.transport === "console") {
    return {
      async send(input) {
        logger.info({ to: input.to, subject: input.subject }, `[console mail]\n${input.text}`);
      },
    };
  }

  const transporter = nodemailer.createTransport({
    host: env.mail.smtp.host,
    port: env.mail.smtp.port,
    secure: env.mail.smtp.secure,
    auth: env.mail.smtp.user ? { user: env.mail.smtp.user, pass: env.mail.smtp.password } : undefined,
  });

  return {
    async send(input) {
      await transporter.sendMail({
        from: env.mail.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
    },
  };
}

let instance: Mailer | undefined;

export function getMailer(): Mailer {
  instance ??= createMailer();
  return instance;
}
