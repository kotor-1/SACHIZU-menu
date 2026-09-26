import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Next.js の dev サーバーはモジュールを繰り返し評価するため、
 * globalThis にキャッシュしないとコネクションが増え続ける。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const baseClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = baseClient;
}

/**
 * [R12 unified composer] ambient transaction。
 *
 * `runInAmbientTransaction()` の callback 内（async context が続く限り）では、`prisma.<model>` と
 * `prisma.$transaction()` が 1 つの interactive transaction client に合流する。既存 repository /
 * service（running plan service 等）を書き換えずに、複数の既存操作を 1 transaction で
 * commit / rollback するための仕組み。callback の外では従来どおり global client そのもの。
 */
const ambientTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();

function joinAmbientTransaction(tx: Prisma.TransactionClient) {
  return async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (client: Prisma.TransactionClient) => unknown)(tx);
    // 配列形式: 各 PrismaPromise は tx client から作られている（この proxy 経由）ので順に解決する。
    const results: unknown[] = [];
    for (const operation of arg as readonly PromiseLike<unknown>[]) results.push(await operation);
    return results;
  };
}

export const prisma: PrismaClient = new Proxy(baseClient, {
  get(target, prop) {
    const tx = ambientTransaction.getStore();
    if (tx !== undefined && typeof prop === "string") {
      if (prop === "$transaction") return joinAmbientTransaction(tx);
      // model delegate と $queryRaw 等。tx client に無い $connect / $disconnect 等は global client のまま。
      if (prop in tx) return Reflect.get(tx, prop);
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/**
 * callback 全体を 1 つの interactive transaction で実行する。callback が throw すれば全体が rollback。
 * 入れ子で呼ばれた場合は外側の transaction にそのまま合流する。
 */
export async function runInAmbientTransaction<T>(
  callback: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (ambientTransaction.getStore() !== undefined) return callback();
  return baseClient.$transaction((tx) => ambientTransaction.run(tx, callback), {
    timeout: options.timeoutMs ?? 30_000,
    maxWait: 10_000,
  });
}

/** Global client と interactive transaction client の共通 repository 境界。 */
export type PrismaDbClient = PrismaClient | Prisma.TransactionClient;
