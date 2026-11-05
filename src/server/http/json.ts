// Тут перевіряю POST-запити, які можуть змінити дані через API
// Перш ніж читати тіло JSON, перевіряю адресу сторінки та тип даних запиту

import express from "express";
import type { RequestHandler } from "express";
import { normalizeOrigin } from "../config.js";
import type { AppConfig } from "../config.js";
import { sendError } from "../auth/errors.js";

// Для POST вимагаю дозволений Origin і Content-Type application/json
// Обмежую розмір тіла та використовую строгий JSON-парсер, щоб не приймати надмірні або некоректні дані
// Помилки парсера передаю спільному обробнику Express
export function jsonMutationGuard(
  config: AppConfig,
  limit: string,
): RequestHandler {
  const parse = express.json({ limit, strict: true, type: () => true });
  return (request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (request.method !== "POST") {
      next();
      return;
    }
    const origin = request.get("Origin");
    const normalized = origin ? normalizeOrigin(origin) : null;
    if (!normalized || !config.appOrigins.has(normalized)) {
      sendError(
        response,
        403,
        "ORIGIN_FORBIDDEN",
        "Походження запиту не дозволене.",
      );
      return;
    }
    const contentType = request
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      sendError(
        response,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Для цього запиту потрібен Content-Type: application/json.",
      );
      return;
    }
    response.locals.jsonBodyLimit = limit;
    parse(request, response, next);
  };
}
