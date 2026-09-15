import type {
  EnergySystem,
  ExerciseCategory,
  TrainingTarget,
} from "@/domain/exercise/constants";
import type { PrescriptionKind } from "./constants";

/**
 * 分類に必要な種目の情報だけを抜き出した型。
 * Prisma の行でも、ピッカーの軽量行でも、テストの手書きオブジェクトでも
 * そのまま渡せるように最小限にしてある。
 */
export type ClassifiableExercise = {
  category: string;
  energySystem?: string | null;
  difficulty?: number | null;
  targets?: readonly string[];
};

function hasTarget(
  ex: ClassifiableExercise,
  target: TrainingTarget,
): boolean {
  return (ex.targets ?? []).includes(target);
}

/**
 * 種目 → 処方タイプ。
 *
 * energySystem は後から足した列なので、既存の種目には入っていない。
 * **energySystem が null でも category / targets だけで必ずどれかに落ちる**
 * ように書いてある（未分類を返さない）。
 */
export function classify(ex: ClassifiableExercise): PrescriptionKind {
  const category = ex.category as ExerciseCategory;
  const energy = (ex.energySystem ?? null) as EnergySystem | null;

  // 1. カテゴリだけで一意に決まるもの
  switch (category) {
    case "COOL_DOWN":
      return "COOLDOWN";
    case "WARM_UP":
    case "MOBILITY":
      return "MOBILITY_WARMUP";
    case "CORE":
      return "CORE_CIRCUIT";
    case "THROW":
      return "THROW_POWER";
    case "JUMP":
      return "PLYOMETRIC";
    case "STRENGTH":
      // 高難度＝高重量・低回数として扱う。difficulty 未設定は筋肥大側に倒す
      // （安全側。最大筋力の処方を誤って出すより軽い）。
      return (ex.difficulty ?? 3) >= 4 ? "STRENGTH_MAX" : "STRENGTH_HYPERTROPHY";
    default:
      break;
  }

  // 2. エネルギー系と対象能力で決まるもの（SPRINT / HURDLE / DRILL / ENDURANCE / OTHER）
  if (category === "ENDURANCE" || energy === "AEROBIC") {
    return "TEMPO_AEROBIC";
  }
  if (energy === "GLYCOLYTIC" || hasTarget(ex, "SPEED_ENDURANCE")) {
    return "SPEED_ENDURANCE";
  }

  if (category === "SPRINT") {
    if (hasTarget(ex, "ACCELERATION")) return "SPEED_ACCELERATION";
    if (hasTarget(ex, "MAX_VELOCITY")) return "SPEED_MAX_VELOCITY";
    // 対象能力が付いていない走種目は、レストが最も長い＝安全側の加速扱いにする。
    return "SPEED_ACCELERATION";
  }

  if (category === "DRILL" || category === "HURDLE") {
    // ドリルでも全力で走るもの（energySystem を ALACTIC に設定したもの）は
    // 技術ドリルの短いレストでは足りないため、加速走と同じ扱いにする。
    if (energy === "ALACTIC") return "SPEED_ACCELERATION";
    return "DRILL_TECHNICAL";
  }

  // 3. OTHER など判断材料がないもの。
  //    量が最も少なく安全な技術ドリル扱いに寄せる。
  return "DRILL_TECHNICAL";
}
