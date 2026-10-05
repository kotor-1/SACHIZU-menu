/* eslint-disable @typescript-eslint/no-require-imports -- Node preload: block transports before any test imports. */
// Strict offline rehearsal: blocks TCP including loopback, permits only Unix sockets for local tooling.
const fail=()=>{throw new Error("OFFLINE_NETWORK_BLOCKED")};
globalThis.fetch=async()=>fail();
for(const name of ["node:http","node:https"]){const m=require(name);m.request=fail;m.get=fail;}
const net=require("node:net");const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const first=args[0];const values=Array.isArray(first)?first:[first];const value=values[0];if(typeof value==="string"&&!/^\d+$/.test(value))return original.apply(this,args);if(value&&typeof value==="object"&&typeof value.path==="string")return original.apply(this,args);return fail();};
