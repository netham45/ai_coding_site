import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.TERMINAL_TOKEN_SECRET || "dev-terminal-secret";
const ttlSeconds = Number(process.env.TERMINAL_TOKEN_TTL_SECONDS || 300);

type TerminalClaims = {
  taskId: string;
  userId: string;
  exp: number;
};

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPart(payloadPart: string): string {
  return createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

export function issueTerminalToken(taskId: string, userId: string): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const claims: TerminalClaims = { taskId, userId, exp };
  const payloadPart = b64urlEncode(JSON.stringify(claims));
  const signature = signPart(payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString()
  };
}

export function verifyTerminalToken(token: string): TerminalClaims {
  const [payloadPart, signature] = token.split(".");
  if (!payloadPart || !signature) {
    throw new Error("Invalid token format");
  }

  const expected = signPart(payloadPart);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid token signature");
  }

  const claims = JSON.parse(b64urlDecode(payloadPart)) as TerminalClaims;
  if (!claims.taskId || !claims.userId || typeof claims.exp !== "number") {
    throw new Error("Invalid token payload");
  }

  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return claims;
}
