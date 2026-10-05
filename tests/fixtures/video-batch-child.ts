/** Dedicated OS process used only by isolated fault/concurrency tests. */
import { appendFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { VideoBatchRepository } from "@/infra/video-batch/repository";
import { FakeVideoObservationProvider } from "@/infra/video-batch/fake-provider";
import { IsolatedVideoBatchWorker } from "@/application/video-batch/control-plane";

async function main() {
  const [url,itemId,point,ledger,time] = process.argv.slice(2);
  if (process.env.NODE_ENV !== "test" || !url?.startsWith("file:/") || !ledger?.startsWith("/")) throw new Error("ISOLATED_CHILD_ONLY");
  const db = new PrismaClient({datasources:{db:{url}}});
  const repository = new VideoBatchRepository(db,()=>new Date(Number(time)));
  const fake = new FakeVideoObservationProvider(["SUCCESS"],true);
  const kill = () => process.kill(process.pid,"SIGKILL");
  if (point === "BEFORE_CLAIM") kill();
  const provider = { capability:"SYNTHETIC_ONLY" as const, async dispatch(key:string) {
    appendFileSync(ledger,key+"\n",{mode:0o600});
    if (point === "IN_PROVIDER") kill();
    return fake.dispatch(key);
  } };
  try {
    await new IsolatedVideoBatchWorker(repository,provider,"isolated-test",p=>{if(p===point) kill();}).run(itemId,`child-${process.pid}`);
  } finally { await db.$disconnect(); }
}
main().catch(e=>{process.stderr.write(String(e));process.exitCode=1;});
