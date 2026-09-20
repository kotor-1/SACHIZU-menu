/**
 * [R12-A3A] HMAC-SHA256 signed token の primitive。
 *
 * 「署名が通るのは改変されていない payload だけ」であること、そして失敗が **例外ではなく種類** として
 * 返る（期待値・実値・例外内容が外へ出ない）ことを確認する。
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HMAC_TOKEN_MAX_LENGTH,
  HMAC_TOKEN_MIN_KEY_BYTES,
  InvalidSigningKeyError,
  assertUsableSigningKey,
  signHmacToken,
  verifyHmacToken,
} from "@/infra/security/hmac-token";

const KEY = "k".repeat(HMAC_TOKEN_MIN_KEY_BYTES);
const OTHER_KEY = "z".repeat(HMAC_TOKEN_MIN_KEY_BYTES);
const PAYLOAD = '{"b":1,"a":"日本語テキスト"}';

function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** payload と signature を別々に組み立てられるようにして、改変ケースを作る。 */
function segmentsOf(token: string): [string, string] {
  const [payload, signature] = token.split(".");
  return [payload!, signature!];
}

describe("R12-A3A hmac-token", () => {
  it("正しい key で署名した token は検証でき、payload が復元される", () => {
    const token = signHmacToken(PAYLOAD, KEY);
    const result = verifyHmacToken(token, KEY);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  it("payload を 1 byte 変えると signature 不一致で拒否される", () => {
    const [payload, signature] = segmentsOf(signHmacToken(PAYLOAD, KEY));
    const decoded = Buffer.from(payload, "base64url");
    decoded[0] = decoded[0]! ^ 0x01;
    const tampered = `${decoded.toString("base64url")}.${signature}`;
    expect(verifyHmacToken(tampered, KEY)).toEqual({ ok: false, kind: "SIGNATURE_MISMATCH" });
  });

  it("signature を 1 byte 変えると拒否される", () => {
    const [payload, signature] = segmentsOf(signHmacToken(PAYLOAD, KEY));
    const decoded = Buffer.from(signature, "base64url");
    decoded[0] = decoded[0]! ^ 0x01;
    expect(verifyHmacToken(`${payload}.${decoded.toString("base64url")}`, KEY)).toEqual({
      ok: false,
      kind: "SIGNATURE_MISMATCH",
    });
  });

  it("別の key では検証できない", () => {
    expect(verifyHmacToken(signHmacToken(PAYLOAD, KEY), OTHER_KEY)).toEqual({
      ok: false,
      kind: "SIGNATURE_MISMATCH",
    });
  });

  it("signature を正しい長さの別値へ差し替えても拒否される", () => {
    const [payload] = segmentsOf(signHmacToken(PAYLOAD, KEY));
    const forged = Buffer.alloc(32, 7).toString("base64url");
    expect(verifyHmacToken(`${payload}.${forged}`, KEY)).toEqual({ ok: false, kind: "SIGNATURE_MISMATCH" });
  });

  it("segment 数が 2 でない token は拒否される", () => {
    const token = signHmacToken(PAYLOAD, KEY);
    const [payload, signature] = segmentsOf(token);
    expect(verifyHmacToken(payload, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
    expect(verifyHmacToken(`${token}.`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
    expect(verifyHmacToken(`${payload}.${signature}.${signature}`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
    expect(verifyHmacToken(`${b64urlEncode("")}.${signature}`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
  });

  it("truncate された token は拒否される", () => {
    const token = signHmacToken(PAYLOAD, KEY);
    const [payload, signature] = segmentsOf(token);
    // signature を 1 文字削る。43 文字 → 42 文字は base64url として canonical でない場合があるため、
    // 「non-canonical encoding（MALFORMED）」か「長さ不一致（SIGNATURE_MISMATCH）」のどちらかで拒否される。
    // どちらにせよ **通ってはいけない**（kind を固定しないのが正しい期待値）。
    const truncatedSignature = verifyHmacToken(`${payload}.${signature.slice(0, -1)}`, KEY);
    expect(truncatedSignature.ok).toBe(false);
    if (!truncatedSignature.ok) expect(["MALFORMED", "SIGNATURE_MISMATCH"]).toContain(truncatedSignature.kind);
    // payload を 1 文字削る（署名対象が変わる）
    const truncatedPayload = verifyHmacToken(`${payload.slice(0, -1)}.${signature}`, KEY);
    expect(truncatedPayload.ok).toBe(false);
    // 途中で切る
    expect(verifyHmacToken(token.slice(0, Math.floor(token.length / 2)), KEY).ok).toBe(false);
  });

  it("base64url alphabet 外の文字を含む token は拒否される（例外を投げない）", () => {
    const token = signHmacToken(PAYLOAD, KEY);
    const [payload, signature] = segmentsOf(token);
    for (const bad of ["+", "/", "=", "!", " "]) {
      expect(verifyHmacToken(`${payload}${bad}.${signature}`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
      expect(() => verifyHmacToken(`${bad}${payload}.${signature}`, KEY)).not.toThrow();
    }
  });

  it("長さ不正な base64url は round-trip 検証で拒否される", () => {
    const [, signature] = segmentsOf(signHmacToken(PAYLOAD, KEY));
    // 1 文字は 6 bit しかなく 1 byte に満たない → decode 結果が空になり round-trip しない
    expect(verifyHmacToken(`A.${signature}`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
    expect(verifyHmacToken(`${b64urlEncode("{}")}.${signature}`, KEY).ok).toBe(false);
  });

  it("余剰 bit を持つ非 canonical base64url は canonicality 検査で拒否される", () => {
    const [payload] = segmentsOf(signHmacToken(PAYLOAD, KEY));
    // "AB" は 12 bit → 1 byte + 余剰 4 bit が非ゼロ。canonical な再エンコードは "AA" になるため round-trip しない。
    // 長さ検査（32 byte 期待）より **前** に落ちることを、署名長と無関係な 1 byte 値で確認する。
    expect(Buffer.from("AB", "base64url").toString("base64url")).toBe("AA");
    expect(verifyHmacToken(`${payload}.AB`, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
    // 対照: 余剰 bit がゼロなら canonical なので decode は成功し、**署名長の不一致**で落ちる
    // （canonicality 検査ではなく長さ検査に到達していることの確認）
    expect(Buffer.from("AQ", "base64url").toString("base64url")).toBe("AQ");
    expect(verifyHmacToken(`${payload}.AQ`, KEY)).toEqual({ ok: false, kind: "SIGNATURE_MISMATCH" });
  });

  it("不正な UTF-8 byte 列の payload は検証を通っても拒否される", () => {
    // 0xff は単体で valid な UTF-8 ではない。signature は正しく作る（改変ではなく encoding の問題）。
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
    const signature = createHmac("sha256", Buffer.from(KEY, "utf8")).update(invalidUtf8).digest().toString("base64url");
    expect(verifyHmacToken(`${invalidUtf8.toString("base64url")}.${signature}`, KEY)).toEqual({
      ok: false,
      kind: "MALFORMED",
    });
  });

  it("上限を超える長さの token は decode 前に拒否される", () => {
    const huge = "a".repeat(HMAC_TOKEN_MAX_LENGTH + 1);
    expect(verifyHmacToken(huge, KEY)).toEqual({ ok: false, kind: "MALFORMED" });
  });

  it("string 以外・空文字は拒否される（例外を投げない）", () => {
    for (const bad of [undefined, null, 123, {}, [], "", "no-dot"]) {
      expect(() => verifyHmacToken(bad as unknown as string, KEY)).not.toThrow();
      expect(verifyHmacToken(bad as unknown as string, KEY).ok).toBe(false);
    }
  });

  it("鍵は fail closed: 空・短すぎる・型違いは署名も検証もしない", () => {
    for (const bad of ["", "short", "x".repeat(HMAC_TOKEN_MIN_KEY_BYTES - 1)]) {
      expect(() => signHmacToken(PAYLOAD, bad)).toThrow(InvalidSigningKeyError);
      expect(() => verifyHmacToken(signHmacToken(PAYLOAD, KEY), bad)).toThrow(InvalidSigningKeyError);
    }
    expect(() => signHmacToken(PAYLOAD, undefined as unknown as string)).toThrow(InvalidSigningKeyError);
    expect(() => signHmacToken(PAYLOAD, new Uint8Array(0))).toThrow(InvalidSigningKeyError);
    expect(() => assertUsableSigningKey("k".repeat(HMAC_TOKEN_MIN_KEY_BYTES - 1))).toThrow(InvalidSigningKeyError);
    expect(() => assertUsableSigningKey(KEY)).not.toThrow();
  });

  it("Uint8Array の鍵も同じ結果になる（表現だけの違い）", () => {
    expect(verifyHmacToken(signHmacToken(PAYLOAD, new TextEncoder().encode(KEY)), new TextEncoder().encode(KEY))).toEqual({
      ok: true,
      payload: PAYLOAD,
    });
    expect(signHmacToken(PAYLOAD, new TextEncoder().encode(KEY))).toBe(signHmacToken(PAYLOAD, KEY));
  });

  it("署名は payload bytes に対して決定的", () => {
    expect(signHmacToken(PAYLOAD, KEY)).toBe(signHmacToken(PAYLOAD, KEY));
    expect(signHmacToken(PAYLOAD, KEY)).not.toBe(signHmacToken(`${PAYLOAD} `, KEY));
  });

  it("署名 module は client 側 / domain 側から import されない（server-only boundary の source audit）", () => {
    // lint の no-restricted-imports は block の後勝ちで衝突しうるうえ、動的 import() を見ない。
    // 署名鍵を扱う module の到達可能性は、ここで source を走査して保証する。
    const guardedDirs = ["src/app", "src/components", "src/presentation", "src/domain"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name)) continue;
        const source = fs.readFileSync(full, "utf8");
        if (/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*infra\/security/u.test(source)) {
          offenders.push(full);
        }
      }
    };
    for (const dir of guardedDirs) {
      const absolute = path.resolve(process.cwd(), dir);
      if (fs.existsSync(absolute)) walk(absolute);
    }
    expect(offenders).toEqual([]);
  });
});
