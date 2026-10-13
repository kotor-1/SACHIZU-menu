"use client";

import { useId, useState, type ReactNode } from "react";
import { INPUT_CLASS } from "@/components/ui";
import { TRAINING_LOCATIONS, TRAINING_LOCATION_LABELS, TRAINING_SURFACES, TRAINING_SURFACE_LABELS,
  TRAINING_EQUIPMENT, TRAINING_EQUIPMENT_LABELS, TRAINING_AGE_GROUPS, TRAINING_AGE_GROUP_LABELS,
  TRAINING_GOALS, TRAINING_GOAL_LABELS, type TrainingConditions } from "@/domain/training-proposal/conditions";

const DISTANCES = [0, 10, 20, 30, 50, 60, 100, 200];
const EVENTS = ["100m", "200m", "400m", "ハードル", "走幅跳・三段跳", "走高跳・棒高跳", "中長距離", "投てき", "混成"];
const labelClass = "block space-y-1.5 text-sm font-semibold text-slate-800";
const hintClass = "block text-xs font-normal leading-relaxed text-slate-600";
/** 選ぶと黒く反転するマス。押せる範囲は 44px 以上。 */
const tileClass = (on: boolean) => `flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-900"}`;

// Representative values for bucketed selects. A saved value is shown in its bucket and
// is only replaced when the person changes the select.
const SINCE_OPTIONS = [["72", "3日以上前・最近していない"], ["48", "2日前"], ["24", "昨日"], ["0", "今日"]] as const;
const UNTIL_OPTIONS = [["72", "3日以上先・予定なし"], ["48", "2日後"], ["24", "明日"], ["0", "今日このあと"]] as const;
const COUNT_OPTIONS = [["0", "0回"], ["1", "1回"], ["2", "2回"], ["3", "3回以上"]] as const;
const COMPETITION_OPTIONS = [["0", "今日（大会当日）"], ["1", "明日（大会前日）"], ["2", "2日後"], ["3", "3日後"], ["5", "4〜6日後"], ["7", "1〜2週間後"], ["14", "2週間以上先"]] as const;
const hoursBucket = (hours: number | null) => hours === null ? "" : hours >= 72 ? "72" : hours >= 48 ? "48" : hours >= 24 ? "24" : "0";
const countBucket = (count: number | null) => count === null ? "" : String(Math.min(count, 3));
const daysBucket = (days: number | null) => days === null ? "" : days <= 3 ? String(days) : days <= 6 ? "5" : days <= 13 ? "7" : "14";

function Step({ number, title, description, children }: { number: number; title: string; description?: string; children: ReactNode }) {
  return <section className="border-t-2 border-slate-900 bg-white px-4 pt-4 pb-5 sm:px-6" aria-label={`STEP ${number} ${title}`}>
    <div className="mb-4 flex items-start gap-3">
      {/* ゼッケンのような四角い番号 */}
      <span className="grid h-9 w-9 shrink-0 place-items-center bg-slate-900 text-base font-extrabold tabular-nums text-white" aria-hidden="true">{number}</span>
      <div><h2 className="text-lg font-bold text-slate-900">{title}</h2>{description && <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{description}</p>}</div>
    </div>
    {children}
  </section>;
}
function TriState({ label, value, onChange }: { label: string; value: boolean | null; onChange: (value: boolean | null) => void }) {
  return <label className={labelClass}>{label}<select className={INPUT_CLASS} value={value === null ? "unknown" : value ? "yes" : "no"}
    onChange={event => onChange(event.target.value === "unknown" ? null : event.target.value === "yes")}>
    <option value="unknown">未確認</option><option value="yes">はい</option><option value="no">いいえ</option>
  </select></label>;
}
function NumberField({ label, value, onChange, min = 0, max, step = 1, hint }: {
  label: string; value: number | null; onChange: (value: number | null) => void; min?: number; max: number; step?: number; hint?: string;
}) {
  return <label className={labelClass}>{label}<input className={INPUT_CLASS} type="number" inputMode={step === 1 ? "numeric" : "decimal"}
    min={min} max={max} step={step} value={value ?? ""} placeholder="未確認" onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))} />
    {hint && <span className={hintClass}>{hint}</span>}
  </label>;
}
function BucketSelect({ label, value, options, empty, hint, onChange }: {
  label: string; value: string; options: readonly (readonly [string, string])[]; empty: string; hint?: string; onChange: (value: number | null) => void;
}) {
  return <label className={labelClass}>{label}<select className={INPUT_CLASS} value={value} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}>
    <option value="">{empty}</option>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}
  </select>{hint && <span className={hintClass}>{hint}</span>}</label>;
}

/** All steps stay visible. A location choice never fills safety, equipment, surface or available space. */
export function TrainingConditionsForm({ value, onChange, disabled = false }: {
  value: TrainingConditions; onChange: (value: TrainingConditions) => void; disabled?: boolean;
}) {
  const groupId = useId();
  const [distanceMode, setDistanceMode] = useState<"PRESET" | "OTHER" | "LONG">((value.environment.straightMeters ?? 0) >= 400 ? "LONG"
    : value.environment.straightMeters !== null && !DISTANCES.includes(value.environment.straightMeters) ? "OTHER" : "PRESET");
  const [eventMode, setEventMode] = useState<"PRESET" | "OTHER">(EVENTS.includes(value.athlete.event) ? "PRESET" : "OTHER");
  const sharedPublicSpace = value.location === "PARK" || value.location === "ROAD";
  const indoor = value.location === "INDOOR";
  const locationHint = indoor ? "屋内は床の滑りやすさ、天井の高さ、家具・柱・他の利用者との接触を確認してください。"
    : sharedPublicSpace ? "公園や道路では車・自転車・歩行者の通行、混雑、段差や遊具との接触を確認してください。"
      : value.location === "SCHOOL" ? "校庭では他の授業・部活動、ボールや用具との接触を確認してください。"
        : value.location === "TRACK" ? "競技場でも使えるレーン・直線の範囲が限られる場合があります。実際に使える範囲を選んでください。"
          : "練習区間の路面、他の利用者、置かれた用具などを実際に確認してください。";
  const safetyUnconfirmed = [value.environment.flatSafe, value.environment.trafficFree, value.environment.obstacleFree].some(answer => answer !== true);
  const environment = (patch: Partial<TrainingConditions["environment"]>) => onChange({ ...value, environment: { ...value.environment, ...patch } });
  const athlete = (patch: Partial<TrainingConditions["athlete"]>) => onChange({ ...value, athlete: { ...value.athlete, ...patch } });
  const condition = (patch: Partial<TrainingConditions["condition"]>) => onChange({ ...value, condition: { ...value.condition, ...patch } });
  function location(next: TrainingConditions["location"]) {
    if (next === value.location) return;
    setDistanceMode("PRESET");
    // A new place means its surface, space and safety answers must be checked again.
    onChange({ ...value, location: next, environment: { ...value.environment,
      straightMeters: null, surface: null, flatSafe: null, trafficFree: null, obstacleFree: null, wallStable: null,
      hill: value.environment.hill ? { distanceMeters: null, slopePercent: null, safe: null } : null,
      step: value.environment.step ? { heightCm: null, stable: null, safe: null } : null,
    } });
  }
  function equipment(option: TrainingConditions["environment"]["equipment"][number], checked: boolean) {
    const next = checked ? [...value.environment.equipment, option] : value.environment.equipment.filter(item => item !== option);
    environment({ equipment: next,
      ...(option === "HILL" ? { hill: checked ? { distanceMeters: null, slopePercent: null, safe: null } : null } : {}),
      ...(option === "STEP" ? { step: checked ? { heightCm: null, stable: null, safe: null } : null } : {}),
      ...(option === "WALL" ? { wallStable: null } : {}),
      ...(option === "OTHER" && !checked ? { otherEquipment: "" } : {}),
    });
  }
  function goal(option: TrainingConditions["primaryGoal"], checked: boolean) {
    const goals = checked ? [...value.goals, option] : value.goals.filter(item => item !== option);
    if (!goals.length) return;
    onChange({ ...value, goals, primaryGoal: goals.includes(value.primaryGoal) ? value.primaryGoal : goals[0] });
  }
  function distance(next: string) {
    setDistanceMode(next === "OTHER" || next === "LONG" ? next : "PRESET");
    // "400m以上" records its lower bound; a longer exact value can be typed.
    environment({ straightMeters: next === "LONG" ? 400 : next === "OTHER" || next === "UNKNOWN" ? null : Number(next) });
  }
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-70">
    <legend className="sr-only">練習の条件</legend>
    <Step number={1} title="練習する場所" description="場所と路面を選びます。使える距離・設備は次のステップで確認します。">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelClass}>場所<select className={INPUT_CLASS} value={value.location} onChange={event => location(event.target.value as TrainingConditions["location"])}>
          {TRAINING_LOCATIONS.map(option => <option key={option} value={option}>{TRAINING_LOCATION_LABELS[option]}</option>)}
        </select></label>
        <label className={labelClass}>路面<select className={INPUT_CLASS} value={value.environment.surface ?? ""} required onChange={event => environment({ surface: event.target.value === "" ? null : event.target.value as NonNullable<TrainingConditions["environment"]["surface"]> })}>
          <option value="">選択してください</option>
          {TRAINING_SURFACES.map(option => <option key={option} value={option}>{TRAINING_SURFACE_LABELS[option]}</option>)}
        </select>{value.environment.surface === "OTHER" && <span className={hintClass}>「その他」の路面では、移動や跳躍を伴う種目と走練習を提案しません。</span>}</label>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-600">場所を変更すると、路面・距離・安全確認はもう一度選び直します。</p>
    </Step>
    <Step number={2} title="使える距離・設備" description="実際に使えるものを選んでください。安全が分からない項目は「未確認」のままにできます。">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>安全に走れる平地の直線距離<select className={INPUT_CLASS}
            value={distanceMode !== "PRESET" ? distanceMode : value.environment.straightMeters === null ? "UNKNOWN" : String(value.environment.straightMeters)}
            onChange={event => distance(event.target.value)}>
            <option value="UNKNOWN">未確認</option>{DISTANCES.map(meters => <option key={meters} value={meters}>{meters === 0 ? "走れる直線なし" : `${meters}m`}</option>)}<option value="LONG">400m以上</option><option value="OTHER">その他の距離</option>
          </select><span className={hintClass}>折り返しを含まない実際の直線です。走り終えて止まる余裕も含めた長さを選んでください。</span></label>
          {distanceMode !== "PRESET" && <NumberField label={distanceMode === "LONG" ? "400m以上の直線距離（m）" : "その他の直線距離（m）"} value={value.environment.straightMeters} min={distanceMode === "LONG" ? 400 : 0} max={10000} step={0.1} onChange={straightMeters => environment({ straightMeters })} />}
        </div>
        <p className="text-xs leading-relaxed text-slate-600">{locationHint}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <TriState label={indoor ? "床が平坦で滑らず安全に動ける" : "平坦で滑りにくく安全に動ける"} value={value.environment.flatSafe} onChange={flatSafe => environment({ flatSafe })} />
          <TriState label={sharedPublicSpace ? "練習区間に車・自転車の通行がない" : "車や自転車の通行がない"} value={value.environment.trafficFree} onChange={trafficFree => environment({ trafficFree })} />
          <TriState label={indoor ? "天井・柱・他の利用者との接触の心配がない" : sharedPublicSpace ? "歩行者の混雑や遊具との接触の心配がない" : "障害物や接触の心配がない"} value={value.environment.obstacleFree} onChange={obstacleFree => environment({ obstacleFree })} />
        </div>
        {safetyUnconfirmed && <p role="note" className="border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">上の3つの安全確認がすべて「はい」になるまで、練習の候補は提案されません。</p>}
        <fieldset><legend className="mb-2 text-sm font-semibold text-slate-800">使用できる設備・環境（複数選択）</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{TRAINING_EQUIPMENT.map(option => <label key={option}
            className={tileClass(value.environment.equipment.includes(option))}>
            <input type="checkbox" className="h-4 w-4 shrink-0 accent-indigo-500" checked={value.environment.equipment.includes(option)} onChange={event => equipment(option, event.target.checked)} />{TRAINING_EQUIPMENT_LABELS[option]}
          </label>)}</div>
        </fieldset>
        {value.environment.equipment.includes("HILL") && <div className="rounded-md border border-slate-200 bg-slate-50 p-4"><h3 className="mb-3 text-sm font-bold">坂の確認</h3><div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="坂の距離（m）" value={value.environment.hill?.distanceMeters ?? null} max={10000} step={0.1} onChange={distanceMeters => environment({ hill: { distanceMeters, slopePercent: value.environment.hill?.slopePercent ?? null, safe: value.environment.hill?.safe ?? null } })} />
          <NumberField label="傾斜（%）" value={value.environment.hill?.slopePercent ?? null} max={100} step={0.1} onChange={slopePercent => environment({ hill: { distanceMeters: value.environment.hill?.distanceMeters ?? null, slopePercent, safe: value.environment.hill?.safe ?? null } })} />
          <TriState label="坂を安全に使える" value={value.environment.hill?.safe ?? null} onChange={safe => environment({ hill: { distanceMeters: value.environment.hill?.distanceMeters ?? null, slopePercent: value.environment.hill?.slopePercent ?? null, safe } })} />
        </div></div>}
        {value.environment.equipment.includes("STEP") && <div className="rounded-md border border-slate-200 bg-slate-50 p-4"><h3 className="mb-3 text-sm font-bold">段差・台の確認</h3><div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="段差の高さ（cm）" value={value.environment.step?.heightCm ?? null} max={200} step={0.1} onChange={heightCm => environment({ step: { heightCm, stable: value.environment.step?.stable ?? null, safe: value.environment.step?.safe ?? null } })} />
          <TriState label="段差が安定している" value={value.environment.step?.stable ?? null} onChange={stable => environment({ step: { heightCm: value.environment.step?.heightCm ?? null, stable, safe: value.environment.step?.safe ?? null } })} />
          <TriState label="段差を安全に使える" value={value.environment.step?.safe ?? null} onChange={safe => environment({ step: { heightCm: value.environment.step?.heightCm ?? null, stable: value.environment.step?.stable ?? null, safe } })} />
        </div></div>}
        {value.environment.equipment.includes("WALL") && <TriState label="壁に体重をかけても安定している" value={value.environment.wallStable} onChange={wallStable => environment({ wallStable })} />}
        {value.environment.equipment.includes("OTHER") && <label className={labelClass}>その他の設備・用具<textarea className={INPUT_CLASS} rows={2} maxLength={400} placeholder="例：マット、ベンチ、なわとび" value={value.environment.otherEquipment} onChange={event => environment({ otherEquipment: event.target.value })} /></label>}
      </div>
    </Step>
    <Step number={3} title="対象となる選手" description="年代と経験・レベルは別々に選びます。分からない項目は未確認にできます。">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className={labelClass}>年代<select className={INPUT_CLASS} value={value.athlete.ageGroup} onChange={event => athlete({ ageGroup: event.target.value as TrainingConditions["athlete"]["ageGroup"] })}>
          {TRAINING_AGE_GROUPS.map(option => <option key={option} value={option}>{TRAINING_AGE_GROUP_LABELS[option]}</option>)}
        </select></label>
        <NumberField label="年齢（歳・任意）" value={value.athlete.ageYears} min={6} max={100} onChange={ageYears => athlete({ ageYears })} />
        <label className={labelClass}>学年（任意）<input className={INPUT_CLASS} value={value.athlete.grade} maxLength={40} placeholder="例：高校2年" onChange={event => athlete({ grade: event.target.value })} /></label>
        <label className={labelClass}>競技種目<select className={INPUT_CLASS} value={eventMode === "OTHER" ? "OTHER" : value.athlete.event}
          onChange={event => { const next = event.target.value; setEventMode(next === "OTHER" ? "OTHER" : "PRESET"); athlete({ event: next === "OTHER" ? "" : next }); }}>
          {EVENTS.map(option => <option key={option} value={option}>{option}</option>)}<option value="OTHER">その他</option>
        </select><span className={hintClass}>最高速度・スピード持久力の走処方は100m・200mのみ対応しています。</span></label>
        {eventMode === "OTHER" && <label className={labelClass}>その他の競技種目<input className={INPUT_CLASS} value={value.athlete.event} required maxLength={32} placeholder="例：60m、サッカー" onChange={event => athlete({ event: event.target.value })} /></label>}
        <label className={labelClass}>競技経験<select className={INPUT_CLASS} value={value.athlete.experience} onChange={event => athlete({ experience: event.target.value as TrainingConditions["athlete"]["experience"] })}>
          <option value="UNKNOWN">未確認</option><option value="BEGINNER">始めたばかり</option><option value="EXPERIENCED">継続した経験がある</option>
        </select></label>
        <label className={labelClass}>競技レベル<select className={INPUT_CLASS} value={value.athlete.level} onChange={event => athlete({ level: event.target.value as TrainingConditions["athlete"]["level"] })}>
          <option value="BEGINNER">初心者（基礎から練習）</option><option value="INTERMEDIATE">中級者（基本動作を習得）</option><option value="ADVANCED">上級者（高度な動作に慣れている）</option>
        </select></label>
        <label className={labelClass}>成長段階<select className={INPUT_CLASS} value={value.athlete.maturity ?? ""} onChange={event => athlete({ maturity: event.target.value === "" ? null : event.target.value as TrainingConditions["athlete"]["maturity"] })}>
          <option value="">未確認</option><option value="PRE">成長期前</option><option value="CIRCA">成長期</option><option value="POST">成長期を過ぎている</option><option value="UNKNOWN">分からない</option>
        </select></label>
        <TriState label="コーチ等の見守りがある" value={value.athlete.supervised} onChange={supervised => athlete({ supervised })} />
        <TriState label="スプリント練習に慣れている" value={value.athlete.familiarWithSprint} onChange={familiarWithSprint => athlete({ familiarWithSprint })} />
      </div>
    </Step>
    <Step number={4} title="今回の目的" description="取り組みたい目的を選び、いちばん重視する目的を指定します。">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{TRAINING_GOALS.map(option => <label key={option}
        className={tileClass(value.goals.includes(option))}>
        <input type="checkbox" className="h-4 w-4 shrink-0 accent-indigo-500" checked={value.goals.includes(option)} onChange={event => goal(option, event.target.checked)} />{TRAINING_GOAL_LABELS[option]}
      </label>)}</div>
      <label className={`${labelClass} mt-4 sm:max-w-sm`}>主目的<select className={INPUT_CLASS} value={value.primaryGoal} onChange={event => onChange({ ...value, primaryGoal: event.target.value as TrainingConditions["primaryGoal"] })}>
        {value.goals.map(option => <option key={option} value={option}>{TRAINING_GOAL_LABELS[option]}</option>)}
      </select><span className={hintClass}>走練習は主目的（主目的が走以外なら最初に選んだ走の目的）だけで処方し、複数の走の目的を混ぜません。</span></label>
      {value.goals.includes("SPEED_ENDURANCE") && <label className={`${labelClass} mt-4`}>スピード持久力の練習方法<select className={INPUT_CLASS} value={value.condition.speedEnduranceMode ?? ""}
        onChange={event => condition({ speedEnduranceMode: event.target.value === "" ? null : event.target.value as "SPRINT_SPECIFIC" | "CONTROLLED_90_95" })}>
        <option value="">未確認</option><option value="SPRINT_SPECIFIC">スプリント持久力（十分な回復）</option><option value="CONTROLLED_90_95">90〜95%走（既存ルール）</option>
      </select><span className={hintClass}>未確認の場合は走の処方を保留します。</span></label>}
      {value.goals.includes("SPEED_ENDURANCE") && value.condition.speedEnduranceMode === "CONTROLLED_90_95" && <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
        <p className="mb-3 text-sm leading-relaxed text-slate-600">90〜95%走には、本人の現在の60m基準タイムが必要です。分からない場合は未確認のままにしてください。走の処方を保留します。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>基準タイムの距離<select className={INPUT_CLASS} value={value.condition.referenceDistanceMeters ?? ""}
            onChange={event => condition({ referenceDistanceMeters: event.target.value === "" ? null : Number(event.target.value) })}>
            <option value="">未確認</option><option value="60">60m</option>
          </select></label>
          <NumberField label="本人の現在の60m基準タイム（秒）" value={value.condition.referenceTimeSeconds ?? null} min={0.01} max={300} step={0.01}
            onChange={referenceTimeSeconds => condition({ referenceTimeSeconds })} />
        </div>
      </div>}
    </Step>
    <Step number={5} title="今日の状態・大会予定" description="今の状態を選ぶと、状態に合わない負荷を提案しないようにします。">
      <div className="mb-5 rounded-md border border-slate-200 bg-slate-50 p-4">
        <label htmlFor={`${groupId}-fatigue`} className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-800">疲労度<span className="text-3xl font-extrabold tabular-nums text-slate-900">{value.condition.fatigue}<span className="text-sm font-medium text-slate-500"> / 10</span></span></label>
        <input id={`${groupId}-fatigue`} className="mt-3 h-11 w-full accent-indigo-600" type="range" min={1} max={10} step={1} value={value.condition.fatigue} onChange={event => condition({ fatigue: Number(event.target.value) })} />
        <div className="flex justify-between text-xs text-slate-600"><span>1 ほとんど疲れていない</span><span>10 とても疲れている</span></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className={labelClass}>筋肉痛<select className={INPUT_CLASS} value={value.condition.soreness} onChange={event => condition({ soreness: event.target.value as TrainingConditions["condition"]["soreness"] })}><option value="NONE">なし</option><option value="MILD">軽い</option><option value="STRONG">強い</option></select></label>
        <label className={labelClass}>痛み・違和感<select className={INPUT_CLASS} value={value.condition.pain} onChange={event => condition({ pain: event.target.value as TrainingConditions["condition"]["pain"] })}><option value="NONE">なし</option><option value="PRESENT">あり</option></select></label>
        <label className={labelClass}>体調<select className={INPUT_CLASS} value={value.condition.health} onChange={event => condition({ health: event.target.value as TrainingConditions["condition"]["health"] })}><option value="GOOD">良好</option><option value="FAIR">やや不調</option><option value="POOR">不調</option></select></label>
        {value.condition.pain === "PRESENT" && <label className={`${labelClass} sm:col-span-2 lg:col-span-3`}>痛みの部位・程度<textarea className={INPUT_CLASS} rows={2} required maxLength={400} placeholder="どこが、どの動きで、どの程度痛むか" value={value.condition.painDetails} onChange={event => condition({ painDetails: event.target.value })} /></label>}
        <BucketSelect label="前回の高強度練習" value={hoursBucket(value.condition.hoursSinceHighIntensity)} options={SINCE_OPTIONS} empty="未確認"
          hint="全力に近い走・跳躍・ウエイトなど。部活動や他競技も含めます。" onChange={hoursSinceHighIntensity => condition({ hoursSinceHighIntensity })} />
        <BucketSelect label="次の高強度練習" value={hoursBucket(value.condition.hoursUntilNextHighIntensity)} options={UNTIL_OPTIONS} empty="未確認"
          onChange={hoursUntilNextHighIntensity => condition({ hoursUntilNextHighIntensity })} />
        <BucketSelect label="直近7日間の高強度練習" value={countBucket(value.condition.highIntensitySessionsLast7Days)} options={COUNT_OPTIONS} empty="未確認"
          onChange={highIntensitySessionsLast7Days => condition({ highIntensitySessionsLast7Days })} />
        <BucketSelect label="次の大会まで" value={daysBucket(value.condition.competitionDays)} options={COMPETITION_OPTIONS} empty="予定なし・未定"
          onChange={competitionDays => condition({ competitionDays })} />
        <label className={labelClass}>今回希望する負荷<select className={INPUT_CLASS} value={value.condition.load} onChange={event => condition({ load: event.target.value as TrainingConditions["condition"]["load"] })}><option value="LIGHT">軽め</option><option value="NORMAL">通常</option><option value="HIGH">高め</option></select>
          <span className={hintClass}>高めを選んでも、今日の状態に合わない負荷は提案しません。</span></label>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-slate-600">加速・最高速度・スピード持久の走は、高強度練習の間隔と回数が分からない場合は保留します。</p>
    </Step>
    <Step number={6} title="補足・希望（任意）" description="条件に加えて伝えたいことがあれば入力してください。選択した安全条件や設備は変更されません。">
      <label className={labelClass}>今回の希望<textarea className={INPUT_CLASS} rows={3} maxLength={2000} value={value.notes} placeholder="例：慣れた種目を中心にしたい、腕振りを確認したい" onChange={event => onChange({ ...value, notes: event.target.value })} /></label>
    </Step>
  </fieldset>;
}
