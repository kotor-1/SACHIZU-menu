import { PrismaClient } from "@prisma/client";

/**
 * Next.js の dev サーバーはモジュールを繰り返し評価するため、
 * globalThis にキャッシュしないとコネクションが増え続ける。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
