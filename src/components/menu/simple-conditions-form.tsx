"use client";

import {
  DEFAULT_STRAIGHT_BY_LOCATION, SIMPLE_ATHLETES, SIMPLE_ATHLETE_LABELS, SIMPLE_DISTANCES, SIMPLE_GOALS, SIMPLE_GOAL_LABELS,
  SIMPLE_LOCATIONS, SIMPLE_LOCATION_LABELS, SIMPLE_STATES, SIMPLE_STATE_LABELS, simpleDistanceLabel, type SimpleConditions,
} from "@/domain/training-proposal/simple-conditions";

/** 選ぶと黒く反転するマス。押せる範囲は 44px 以上。 */
const tileClass = (on: boolean) => `flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-center text-sm font-semibold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-600 ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-900"}`;

function Question<T extends string | number>({ number, title, name, options, value, label, onChange, columns }: {
  number: number; title: string; name: string; options: readonly T[]; value: T; label: (option: T) => string; onChange: (option: T) => void; columns: string;
}) {
  return <fieldset className="min-w-0 border-t-2 border-slate-900 bg-white px-4 pt-4 pb-5 sm:px-6">
    <legend className="sr-only">{title}</legend>
    <div className="mb-3 flex items-center gap-3">
      {/* ゼッケンのような四角い番号 */}
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center bg-slate-900 text-base font-extrabold tabular-nums text-white">{number}</span>
      <h2 className="text-lg font-bold text-slate-900">{title}</h2>
    </div>
    <div className={`grid gap-2 ${columns}`}>
      {options.map(option => <label key={String(option)} className={tileClass(value === option)}>
        <input type="radio" name={name} value={String(option)} className="sr-only" checked={value === option} onChange={() => onChange(option)} />
        {label(option)}
      </label>)}
    </div>
  </fieldset>;
}

/** 選ぶのは5つだけ。場所を選ぶと、走れる直線にその場所の目安が入る（あとから変えられる）。 */
export function SimpleConditionsForm({ value, onChange, disabled = false }: {
  value: SimpleConditions; onChange: (value: SimpleConditions) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-70">
    <legend className="sr-only">練習の条件</legend>
    <Question number={1} title="場所" name="location" options={SIMPLE_LOCATIONS} value={value.location} label={option => SIMPLE_LOCATION_LABELS[option]}
      columns="grid-cols-2 sm:grid-cols-5" onChange={location => onChange({ ...value, location, straightMeters: DEFAULT_STRAIGHT_BY_LOCATION[location] })} />
    <Question number={2} title="走れる直線" name="straightMeters" options={SIMPLE_DISTANCES} value={value.straightMeters} label={simpleDistanceLabel}
      columns="grid-cols-4 sm:grid-cols-8" onChange={straightMeters => onChange({ ...value, straightMeters })} />
    <Question number={3} title="選手" name="athlete" options={SIMPLE_ATHLETES} value={value.athlete} label={option => SIMPLE_ATHLETE_LABELS[option]}
      columns="grid-cols-2 sm:grid-cols-3" onChange={athlete => onChange({ ...value, athlete })} />
    <Question number={4} title="目的" name="goal" options={SIMPLE_GOALS} value={value.goal} label={option => SIMPLE_GOAL_LABELS[option]}
      columns="grid-cols-3" onChange={goal => onChange({ ...value, goal })} />
    <Question number={5} title="今日の状態" name="state" options={SIMPLE_STATES} value={value.state} label={option => SIMPLE_STATE_LABELS[option]}
      columns="grid-cols-2 sm:grid-cols-4" onChange={state => onChange({ ...value, state })} />
  </fieldset>;
}
