import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { webFile } from "./asset-paths.js";

const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const assets = new Map([
  ["/admin", ["admin.html", "text/html"]],
  ["/admin/", ["admin.html", "text/html"]],
  ["/admin/admin.js", ["admin.js", "text/javascript"]],
  ["/admin/admin.css", ["admin.css", "text/css"]],
]);
const cookieName = "noknok_admin";
export function validateAdminKeyHash(hash?: string) {
  if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
    throw new TypeError(
      "NOKNOK_ADMIN_KEY_HASH must be a lowercase SHA-256 hex digest."
    );
}

export function createAdmin({
  keyHash,
  realm,
  snapshot,
}: {
  keyHash?: string;
  realm: string;
  snapshot: () => unknown;
}) {
  validateAdminKeyHash(keyHash);
  const sessions = new Map<string, number>();
  let window = 0,
    attempts = 0,
    reads = 0;
  const secure = new URL(realm).protocol === "https:";
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${
      secure ? "; Secure" : ""
    }`;
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  function send(res: ServerResponse, code: number, value: unknown, extra = {}) {
    res.writeHead(code, { ...headers, ...extra });
    res.end(JSON.stringify(value));
  }
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/"))
        return false;
      if (!keyHash || url.search) {
        send(res, 404, { error: "not_found" });
        return true;
      }
      const now = Date.now();
      for (const [token, expiry] of sessions)
        if (expiry <= now) sessions.delete(token);
      if (now - window >= 60000) {
        window = now;
        attempts = 0;
        reads = 0;
      }
      if (
        (req.headers.origin && req.headers.origin !== realm) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        send(res, 403, { error: "origin_denied" });
        return true;
      }
      if (req.method === "GET" && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname)!;
        res.writeHead(200, {
          ...headers,
          "Content-Type": `${type}; charset=utf-8`,
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
        });
        res.end(await readFile(webFile(file)));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/admin/api/login") {
        if (req.headers.origin !== realm) {
          send(res, 403, { error: "origin_denied" });
          return true;
        }
        if (++attempts > 10) {
          send(res, 429, { error: "login_limited" }, { "Retry-After": "60" });
          return true;
        }
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
        ) {
          send(res, 415, { error: "json_required" });
          return true;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) {
            send(res, 413, { error: "body_too_large" });
            return true;
          }
          chunks.push(chunk);
        }
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          send(res, 400, { error: "invalid_request" });
          return true;
        }
        if (
          !value ||
          typeof value.key !== "string" ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(value.key) ||
          !timingSafeEqual(
            Buffer.from(digest(value.key), "hex"),
            Buffer.from(keyHash, "hex")
          )
        ) {
          send(res, 401, { error: "invalid_key" });
          return true;
        }
        const token = randomBytes(32).toString("base64url");
        if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
        sessions.set(digest(token), now + 1800000);
        send(res, 200, { ok: true }, { "Set-Cookie": cookie(token, 1800) });
        return true;
      }
      const token = req.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const session = token && sessions.get(digest(token));
      if (!session || session <= now) {
        send(res, 401, { error: "unauthenticated" });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/admin/api/logout") {
        if (req.headers.origin !== realm) {
          send(res, 403, { error: "origin_denied" });
          return true;
        }
        sessions.delete(digest(token!));
        send(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
        return true;
      }
      if (req.method === "GET" && url.pathname === "/admin/api/overview") {
        if (++reads > 60)
          send(res, 429, { error: "read_limited" }, { "Retry-After": "60" });
        else send(res, 200, snapshot());
        return true;
      }
      send(res, 404, { error: "not_found" });
      return true;
    },
    close() {
      sessions.clear();
    },
  };
}
