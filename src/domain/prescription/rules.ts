import type { TrainingPhase } from "@/domain/menu/constants";
import {
  type AthleteLevel,
  type PrescriptionKind,
} from "./constants";

/**
 * 処方の定数表。
 *
 * ここに書いてある数値がこのアプリの「トレーニング生理学」そのもの。
 * 変更するときは必ず tests/domain/prescription-rules.test.ts も一緒に直すこと。
 *
 * 基準は **高校上級 × 試合前期**。ここから
 *   - レベル係数（LEVEL_VOLUME_FACTOR）… 総量にだけ掛ける
 *   - 期分け係数（PHASE_ADJUSTMENT）  … 総量と強度に掛ける
 * を適用して最終値を出す（calculate.ts）。
 */

export type RestPolicy =
  /** 距離から完全回復レストを計算する（ATP-CP系） */
  | "COMPLETE_BY_DISTANCE"
  /** 定数表の restSeconds をそのまま使う */
  | "FIXED";

export type PrescriptionRule = {
  /** 基準強度。%1RM か %最大努力かは kind で読み分ける。null は強度を書かない種目。 */
  intensityPercent: number | null;
  /** 1 本の距離（m）。 */
  distanceMeters: number | null;
  /** 1 本の時間（秒）。 */
  durationSeconds: number | null;
  /** 1 セットあたりの本数・回数。距離で測る種目では「本数」。 */
  reps: number | null;
  /**
   * metricType が REPS の種目に使う 1 セットあたりの回数。
   * 距離ドリルの「25m を 3 本」と、回数ドリルの「10 回」は数が違うため分けている。
   * null なら reps をそのまま使う。
   */
  repsWhenCounted: number | null;
  /** セット数。 */
  sets: number;
  /** 本間レスト（秒）。restPolicy = FIXED のときだけ使う。 */
  restSeconds: number | null;
  restPolicy: RestPolicy;
  /** セット間レスト（秒）。MenuItem は 1 つしかレスト欄を持たないため note に書く。 */
  setRestSeconds: number | null;
  /** 1 回の練習でこの系統に許す総距離（m）。null は距離で管理しない。 */
  volumeCapMeters: number | null;
  /** 1 回の練習で許す総接地数。プライオ専用。 */
  volumeCapContacts: number | null;
  /** なぜこの設定なのか。根拠として必ず表示する。 */
  rationale: string;
};

export const PRESCRIPTION_RULES: Record<PrescriptionKind, PrescriptionRule> = {
  // --- スピード系 -----------------------------------------------------------
  // ATP-CP（クレアチンリン酸）の再合成には完全回復が要る。レストを削ると
  // 狙いが最高速度からスピード持久にすり替わるので、短くする提案は出さない。
  SPEED_ACCELERATION: {
    intensityPercent: 95,
    distanceMeters: 30,
    durationSeconds: null,
    reps: 5,
    repsWhenCounted: null,
    sets: 2,
    restSeconds: null,
    restPolicy: "COMPLETE_BY_DISTANCE",
    setRestSeconds: 420,
    volumeCapMeters: 400,
    volumeCapContacts: null,
    rationale:
      "ATP-CP系。1本を6秒以内に収め、完全回復をとって毎本を最大努力で走る。",
  },
  SPEED_MAX_VELOCITY: {
    intensityPercent: 95,
    distanceMeters: 50,
    durationSeconds: null,
    reps: 4,
    repsWhenCounted: null,
    sets: 2,
    restSeconds: null,
    restPolicy: "COMPLETE_BY_DISTANCE",
    setRestSeconds: 540,
    volumeCapMeters: 400,
    volumeCapContacts: null,
    rationale:
      "ATP-CP系。最高速度は疲労が入ると出ないため、加速区間より長いレストをとる。",
  },
  SPEED_ENDURANCE: {
    intensityPercent: 90,
    distanceMeters: 120,
    durationSeconds: null,
    reps: 3,
    repsWhenCounted: null,
    sets: 2,
    restSeconds: 360,
    restPolicy: "FIXED",
    setRestSeconds: 720,
    volumeCapMeters: 800,
    volumeCapContacts: null,
    rationale:
      "解糖系。不完全回復のまま高い速度を保つのが狙いなので、レストは意図的に足りない設定にする。",
  },
  TEMPO_AEROBIC: {
    intensityPercent: 75,
    distanceMeters: 150,
    durationSeconds: null,
    reps: 8,
    repsWhenCounted: null,
    sets: 2,
    restSeconds: 60,
    restPolicy: "FIXED",
    setRestSeconds: 240,
    volumeCapMeters: 2000,
    volumeCapContacts: null,
    rationale:
      "有酸素系。速度を上げずに量を確保する。レストを短く保つことで回復能力を刺激する。",
  },

  // --- 技術・跳躍・投 -------------------------------------------------------
  DRILL_TECHNICAL: {
    intensityPercent: null,
    distanceMeters: 25,
    durationSeconds: null,
    reps: 3,
    repsWhenCounted: 10,
    sets: 2,
    restSeconds: 75,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale:
      "技術ドリルは疲労ではなく動きの質で管理する。フォームが崩れる本数は踏まない。",
  },
  PLYOMETRIC: {
    intensityPercent: null,
    distanceMeters: null,
    durationSeconds: null,
    reps: 10,
    repsWhenCounted: null,
    sets: 4,
    restSeconds: 120,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: 120,
    rationale:
      "跳躍系は接地数で管理する。反発を使えなくなった時点で狙いから外れるためレストを長めにとる。",
  },
  THROW_POWER: {
    intensityPercent: null,
    distanceMeters: null,
    durationSeconds: null,
    reps: 6,
    repsWhenCounted: null,
    sets: 3,
    restSeconds: 90,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale: "爆発的に投げる種目。1投ごとの出力が落ちない本数に留める。",
  },

  // --- 筋力 -----------------------------------------------------------------
  STRENGTH_MAX: {
    intensityPercent: 88,
    distanceMeters: null,
    durationSeconds: null,
    reps: 4,
    repsWhenCounted: null,
    sets: 4,
    restSeconds: 240,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale:
      "最大筋力（%1RM）。神経系への刺激が目的なので、回数を増やさずレストを長くとる。",
  },
  STRENGTH_HYPERTROPHY: {
    intensityPercent: 75,
    distanceMeters: null,
    durationSeconds: null,
    reps: 10,
    repsWhenCounted: null,
    sets: 3,
    restSeconds: 75,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale: "筋肥大（%1RM）。総仕事量を稼ぐためレストは短めにする。",
  },

  // --- 補強・W-up・C-down ---------------------------------------------------
  CORE_CIRCUIT: {
    intensityPercent: null,
    distanceMeters: null,
    durationSeconds: 40,
    reps: 15,
    repsWhenCounted: null,
    sets: 3,
    restSeconds: 20,
    restPolicy: "FIXED",
    setRestSeconds: 120,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale: "サーキット形式。種目間を詰めて回すため 1 種目のレストは短い。",
  },
  MOBILITY_WARMUP: {
    intensityPercent: null,
    distanceMeters: 20,
    durationSeconds: 30,
    // 距離で行う W-up ドリルは 20m を 2 本。回数で行うものは 10 回。
    reps: 2,
    repsWhenCounted: 10,
    sets: 1,
    restSeconds: 0,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale: "主運動の準備。疲労を残さないため 1 セットで通す。",
  },
  COOLDOWN: {
    intensityPercent: null,
    distanceMeters: null,
    durationSeconds: 300,
    reps: null,
    repsWhenCounted: null,
    sets: 1,
    restSeconds: null,
    restPolicy: "FIXED",
    setRestSeconds: null,
    volumeCapMeters: null,
    volumeCapContacts: null,
    rationale: "整理運動。強度は指定しない。",
  },
};

/**
 * レベル係数。**総量にだけ**掛ける。
 * 強度を下げないのは、強度を落とすと狙うエネルギー系が変わってしまうため。
 * 中学生に必要なのは「同じ質を、少ない量で」。
 */
export const LEVEL_VOLUME_FACTOR: Record<AthleteLevel, number> = {
  JHS: 0.6,
  HS_BEGINNER: 0.75,
  HS_ADVANCED: 1.0,
  UNIVERSITY_PLUS: 1.2,
};

/** 期分けによる調整。量は係数、強度は加算（%ポイント）。 */
export type PhaseAdjustment = {
  volumeFactor: number;
  intensityDelta: number;
  label: string;
};

export const PHASE_ADJUSTMENT: Record<TrainingPhase, PhaseAdjustment> = {
  PREPARATION: { volumeFactor: 1.2, intensityDelta: -5, label: "準備期" },
  PRE_COMPETITION: { volumeFactor: 1.0, intensityDelta: 0, label: "試合前期" },
  COMPETITION: { volumeFactor: 0.7, intensityDelta: 2, label: "試合期" },
  TRANSITION: { volumeFactor: 0.5, intensityDelta: -15, label: "移行期" },
};

/** 期分け未指定のときの既定。定数表の基準そのまま。 */
export const NEUTRAL_PHASE_ADJUSTMENT: PhaseAdjustment = {
  volumeFactor: 1.0,
  intensityDelta: 0,
  label: "期分け未指定",
};

/** 完全回復レストの下限・上限（秒）。 */
export const COMPLETE_REST_MIN_SECONDS = 120;
export const COMPLETE_REST_MAX_SECONDS = 600;
/** 完全回復の目安: 走行距離 10m あたり 60 秒。 */
export const COMPLETE_REST_SECONDS_PER_10M = 60;

/**
 * ATP-CP 系の完全回復レストを距離から求める。
 * 30m → 180秒、60m → 360秒。20m 以下でも 2 分は空ける。
 */
export function completeRestSeconds(distanceMeters: number): number {
  const raw = Math.round(
    (distanceMeters / 10) * COMPLETE_REST_SECONDS_PER_10M,
  );
  return Math.min(
    COMPLETE_REST_MAX_SECONDS,
    Math.max(COMPLETE_REST_MIN_SECONDS, raw),
  );
}
