import fs from "node:fs/promises";
import path from "node:path";
import { buildLunaRequest, type LunaFrameInput } from "@/domain/video-batch/luna-request";

/** Reads already extracted, hash-bound private JPEGs only; no decoder, download or upload. */
export async function loadPrivateLunaFrames(privateRoot:string,manifest:Omit<LunaFrameInput,"jpegBase64">[]) {
  if(typeof window!=="undefined")throw new Error("SERVER_ONLY_PROVIDER");
  const root=await fs.realpath(privateRoot);
  if(root.split(path.sep).includes("public"))throw new Error("PRIVATE_FRAMES_REQUIRED");
  const frames:LunaFrameInput[]=[];
  for(const frame of manifest){
    if(path.isAbsolute(frame.filename))throw new Error("PRIVATE_FRAMES_REQUIRED");
    const p=await fs.realpath(path.resolve(root,frame.filename));
    if(!p.startsWith(root+path.sep) || p.split(path.sep).includes("public"))throw new Error("PRIVATE_FRAMES_REQUIRED");
    const stat=await fs.stat(p);
    if(!stat.isFile() || stat.size!==frame.byteSize || stat.size>8*1024*1024)throw new Error("INVALID_FRAME_SIZE");
    frames.push({...frame,jpegBase64:(await fs.readFile(p)).toString("base64")});
  }
  return buildLunaRequest(frames);
}

/** Rehash bound local source bytes before any external count/response; never decodes or downloads. */
export function localLunaSourceVerifier(resolveSource:(ownerId:string,target:import("@/domain/video-batch/contracts").Target)=>Promise<string|null>) {
  return async(ownerId:string,target:import("@/domain/video-batch/contracts").Target)=>{
    const filename=await resolveSource(ownerId,target);if(!filename)return false;
    const {createHash}=await import("node:crypto");const {createReadStream}=await import("node:fs");
    const stat=await fs.stat(filename);if(!stat.isFile())return false;
    const hash=createHash("sha256");for await(const chunk of createReadStream(filename))hash.update(chunk);
    const after=await fs.stat(filename);
    return stat.size===after.size && stat.mtimeMs===after.mtimeMs && hash.digest("hex")===target.sourceBinding.contentSha256;
  };
}
