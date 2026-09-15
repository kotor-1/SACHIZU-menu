/**
 * Running Prescription Engine v2 — RunningTrainingMethod（§2.2, §3.1）。
 *
 * これは「処方データ」ではない。10 種類の Method を型として定義するだけで、
 * envelope の数値・SessionTemplate の実データ・rule set は R2 の責務。
 *
 * 重要: `SUBMAX_SPEED_ENDURANCE` は canonical Method に**含まれない**
 * （Fable C-5 案A。§3.1「`SUBMAX_SPEED_ENDURANCE` は canonical にしない。
 * `TEMPO_INTENSIVE` 配下の template `TI_VITTORI_SE` とする」）。
 */
import { z } from "zod";

/** 正式仕様 §3.1 の10 canonical Method（順序も仕様の表と一致させている）。 */
export const RUNNING_TRAINING_METHODS = [
  "ACCELERATION",
  "MAX_VELOCITY",
  "SPRINT_ENDURANCE_SHORT",
  "LONG_SPRINT_RACE_SPECIFIC",
  "TEMPO_EXTENSIVE",
  "TEMPO_INTENSIVE",
  "RESISTED_SPRINT",
  "ASSISTED_SPRINT",
  "EVENT_APPROACH_SPEED",
  "STRIDE",
] as const;

export const runningTrainingMethodSchema = z.enum(RUNNING_TRAINING_METHODS);
export type RunningTrainingMethod = z.infer<typeof runningTrainingMethodSchema>;
