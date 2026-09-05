/**
 * 初期データ。
 * 空のアプリでは検索もメニュー作成も試せないため、
 * 陸上競技で実際に使われる種目をひと通り入れておく。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedExercise = {
  name: string;
  nameKana: string;
  category: string;
  metricType: string;
  difficulty: number;
  description: string;
  coachingPoint?: string;
  commonMistake?: string;
  targets: string[];
  equipment?: string[];
  tags?: string[];
  defaultSets?: number;
  defaultReps?: number;
  defaultDistanceMeters?: number;
  defaultDurationSeconds?: number;
  defaultRestSeconds?: number;
};

const EXERCISES: SeedExercise[] = [
  // --- ウォームアップ / 可動域 ---
  {
    name: "ジョグ",
    nameKana: "じょぐ",
    category: "WARM_UP",
    metricType: "DISTANCE",
    difficulty: 1,
    description: "体温を上げるための低強度走。会話ができるペースで走る。",
    coachingPoint: "呼吸が乱れない範囲。ペースを上げすぎない。",
    targets: ["ENDURANCE", "RECOVERY"],
    tags: ["定番"],
    defaultDistanceMeters: 1200,
  },
  {
    name: "動的ストレッチ",
    nameKana: "どうてきすとれっち",
    category: "MOBILITY",
    metricType: "TIME",
    difficulty: 1,
    description: "レッグスイング、ヒップサークル等を動かしながら可動域を広げる。",
    coachingPoint: "反動を使いすぎず、可動域の端で止めない。",
    targets: ["MOBILITY"],
    tags: ["定番"],
    defaultDurationSeconds: 600,
  },
  {
    name: "ハードルドリル（またぎ越し）",
    nameKana: "はーどるどりるまたぎこし",
    category: "MOBILITY",
    metricType: "REPS",
    difficulty: 2,
    description: "低めのハードルを前方・側方からまたぎ越し、股関節の可動域を出す。",
    coachingPoint: "骨盤を立てたまま。上体を倒して逃げない。",
    commonMistake: "ハードルが高すぎて体幹が崩れる。",
    targets: ["MOBILITY", "TECHNIQUE"],
    equipment: ["ハードル"],
    defaultSets: 2,
    defaultReps: 6,
    defaultRestSeconds: 30,
  },

  // --- ドリル ---
  {
    name: "Aスキップ",
    nameKana: "えーすきっぷ",
    category: "DRILL",
    metricType: "DISTANCE",
    difficulty: 2,
    description: "腿を引き上げ、真下へ接地するスキップ。走りの基本姿勢を作る。",
    coachingPoint: "接地は体の真下。足首を固定し、腰の位置を高く保つ。",
    commonMistake: "腿上げだけになり、接地が体の前になる。",
    targets: ["TECHNIQUE", "COORDINATION"],
    tags: ["定番", "スプリントドリル"],
    defaultSets: 2,
    defaultDistanceMeters: 30,
    defaultRestSeconds: 60,
  },
  {
    name: "Bスキップ",
    nameKana: "びーすきっぷ",
    category: "DRILL",
    metricType: "DISTANCE",
    difficulty: 3,
    description: "Aスキップから膝下を前に振り出し、引き戻して接地する。",
    coachingPoint: "振り出した脚を能動的に引き戻す。地面を掻く意識。",
    commonMistake: "膝下を振り出したまま接地し、ブレーキがかかる。",
    targets: ["TECHNIQUE", "COORDINATION"],
    tags: ["スプリントドリル"],
    defaultSets: 2,
    defaultDistanceMeters: 30,
    defaultRestSeconds: 60,
  },
  {
    name: "もも上げ（ファストレッグ）",
    nameKana: "ももあげふぁすとれっぐ",
    category: "DRILL",
    metricType: "DISTANCE",
    difficulty: 2,
    description: "片脚のみ素早く引き上げ・引き下ろしを行い、脚の回転を高める。",
    coachingPoint: "接地時間を短く。上体は反らさない。",
    targets: ["TECHNIQUE", "COORDINATION"],
    tags: ["スプリントドリル"],
    defaultSets: 2,
    defaultDistanceMeters: 20,
    defaultRestSeconds: 45,
  },
  {
    name: "ウォールドリル",
    nameKana: "うぉーるどりる",
    category: "DRILL",
    metricType: "REPS",
    difficulty: 2,
    description: "壁に手をついて前傾姿勢を作り、加速局面の脚の入れ替えを反復する。",
    coachingPoint: "頭〜踵まで一直線。腰が折れないよう腹圧を保つ。",
    commonMistake: "尻が落ちて『くの字』になる。",
    targets: ["ACCELERATION", "TECHNIQUE"],
    defaultSets: 3,
    defaultReps: 10,
    defaultRestSeconds: 45,
  },

  // --- スプリント ---
  {
    name: "スタートダッシュ（クラウチング）",
    nameKana: "すたーとだっしゅ",
    category: "SPRINT",
    metricType: "DISTANCE",
    difficulty: 4,
    description: "スターティングブロックからの加速。1次加速局面の技術練習。",
    coachingPoint: "1歩目は真下ではなく後方へ押す。上体は徐々に起こす。",
    commonMistake: "早く起き上がりすぎて加速が切れる。",
    targets: ["ACCELERATION", "POWER", "TECHNIQUE"],
    equipment: ["スターティングブロック"],
    tags: ["短距離"],
    defaultSets: 4,
    defaultDistanceMeters: 30,
    defaultRestSeconds: 240,
  },
  {
    name: "加速走",
    nameKana: "かそくそう",
    category: "SPRINT",
    metricType: "DISTANCE",
    difficulty: 4,
    description: "助走区間で加速し、設定区間を最高速で走り抜ける。",
    coachingPoint: "最高速区間では力まず、リラックスを保つ。",
    targets: ["MAX_VELOCITY", "TECHNIQUE"],
    tags: ["短距離"],
    defaultSets: 3,
    defaultDistanceMeters: 60,
    defaultRestSeconds: 300,
  },
  {
    name: "ウィンドスプリント（流し）",
    nameKana: "うぃんどすぷりんと",
    category: "SPRINT",
    metricType: "DISTANCE",
    difficulty: 2,
    description: "7〜8割の力で滑らかに走る。動きの確認と刺激入れ。",
    coachingPoint: "全力にしない。フォームの再現性を優先。",
    targets: ["TECHNIQUE", "RECOVERY"],
    tags: ["定番"],
    defaultSets: 3,
    defaultDistanceMeters: 80,
    defaultRestSeconds: 120,
  },
  {
    name: "レぺティション 150m",
    nameKana: "れぺてぃしょん150",
    category: "SPRINT",
    metricType: "DISTANCE",
    difficulty: 5,
    description: "十分な休息を挟み、高強度で 150m を繰り返す。スピード持久の中心種目。",
    coachingPoint: "設定タイムを守る。落ちたら本数を打ち切る。",
    commonMistake: "本数をこなすことが目的化し、質が落ちる。",
    targets: ["SPEED_ENDURANCE", "ENDURANCE"],
    tags: ["短距離", "きつい"],
    defaultSets: 4,
    defaultDistanceMeters: 150,
    defaultRestSeconds: 480,
  },

  // --- 跳躍・プライオ ---
  {
    name: "立ち五段跳び",
    nameKana: "たちごだんとび",
    category: "JUMP",
    metricType: "REPS",
    difficulty: 3,
    description: "静止状態から左右交互に 5 歩跳び、到達距離を測る。",
    coachingPoint: "1 歩ごとに接地を短く。上ではなく前へ。",
    targets: ["POWER", "COORDINATION"],
    tags: ["測定可"],
    defaultSets: 3,
    defaultReps: 1,
    defaultRestSeconds: 120,
  },
  {
    name: "バウンディング",
    nameKana: "ばうんでぃんぐ",
    category: "JUMP",
    metricType: "DISTANCE",
    difficulty: 4,
    description: "大きなストライドで跳ぶように走り、脚の弾性を高める。",
    coachingPoint: "接地時間を短く保ちつつ、滞空を作る。",
    commonMistake: "上方向に跳びすぎて前に進まない。",
    targets: ["POWER", "TECHNIQUE"],
    defaultSets: 3,
    defaultDistanceMeters: 30,
    defaultRestSeconds: 120,
  },
  {
    name: "ボックスジャンプ",
    nameKana: "ぼっくすじゃんぷ",
    category: "JUMP",
    metricType: "REPS",
    difficulty: 3,
    description: "台上へ両脚で跳び乗る。着地は静かに。",
    coachingPoint: "降りるときは飛び降りず、必ず step down する。",
    targets: ["POWER"],
    equipment: ["プライオボックス"],
    defaultSets: 3,
    defaultReps: 6,
    defaultRestSeconds: 90,
  },

  // --- ハードル ---
  {
    name: "ハードル 3 歩走",
    nameKana: "はーどるさんぽそう",
    category: "HURDLE",
    metricType: "REPS",
    difficulty: 4,
    description: "ハードル間を 3 歩で走り抜ける。インターバルのリズム習得。",
    coachingPoint: "抜き脚を高く、素早く前へ。踏切位置を一定に。",
    targets: ["TECHNIQUE", "SPEED_ENDURANCE"],
    equipment: ["ハードル"],
    tags: ["ハードル"],
    defaultSets: 4,
    defaultReps: 5,
    defaultRestSeconds: 180,
  },

  // --- 持久 ---
  {
    name: "ペース走",
    nameKana: "ぺーすそう",
    category: "ENDURANCE",
    metricType: "DISTANCE",
    difficulty: 3,
    description: "設定ペースを維持して一定距離を走る。",
    coachingPoint: "ラップのばらつきを 3 秒以内に収める。",
    targets: ["ENDURANCE"],
    tags: ["長距離"],
    defaultDistanceMeters: 5000,
  },
  {
    name: "インターバル 400m",
    nameKana: "いんたーばる400",
    category: "ENDURANCE",
    metricType: "DISTANCE",
    difficulty: 5,
    description: "400m を設定タイムで走り、短い休息で繰り返す。",
    coachingPoint: "1 本目から突っ込まない。最後の 2 本を上げる。",
    targets: ["ENDURANCE", "SPEED_ENDURANCE"],
    tags: ["長距離", "きつい"],
    defaultSets: 8,
    defaultDistanceMeters: 400,
    defaultRestSeconds: 90,
  },

  // --- 筋力 ---
  {
    name: "バックスクワット",
    nameKana: "ばっくすくわっと",
    category: "STRENGTH",
    metricType: "REPS",
    difficulty: 4,
    description: "バーベルを担ぎ、股関節と膝を同時に曲げてしゃがむ。",
    coachingPoint: "膝とつま先の向きを揃える。腹圧を抜かない。",
    commonMistake: "腰が丸まる（バットウィンク）。",
    targets: ["STRENGTH", "POWER"],
    equipment: ["バーベル", "ラック"],
    tags: ["ウエイト"],
    defaultSets: 4,
    defaultReps: 5,
    defaultRestSeconds: 180,
  },
  {
    name: "ルーマニアンデッドリフト",
    nameKana: "るーまにあんでっどりふと",
    category: "STRENGTH",
    metricType: "REPS",
    difficulty: 3,
    description: "膝を軽く曲げたまま股関節を折り、ハムストリングを伸ばす。",
    coachingPoint: "バーを体に沿わせる。背中は最後まで真っ直ぐ。",
    targets: ["STRENGTH", "MOBILITY"],
    equipment: ["バーベル"],
    tags: ["ウエイト"],
    defaultSets: 3,
    defaultReps: 8,
    defaultRestSeconds: 120,
  },
  {
    name: "ノルディックハムストリング",
    nameKana: "のるでぃっくはむすとりんぐ",
    category: "STRENGTH",
    metricType: "REPS",
    difficulty: 4,
    description: "足首を固定し、膝立ちからゆっくり前傾する。肉離れ予防の定番。",
    coachingPoint: "耐えられる範囲まで。腰を折らず体は一直線。",
    targets: ["STRENGTH"],
    tags: ["傷害予防"],
    defaultSets: 3,
    defaultReps: 5,
    defaultRestSeconds: 90,
  },

  // --- 体幹・補強 ---
  {
    name: "プランク",
    nameKana: "ぷらんく",
    category: "CORE",
    metricType: "TIME",
    difficulty: 1,
    description: "前腕とつま先で体を支え、一直線を保つ。",
    coachingPoint: "腰を落とさない・上げない。呼吸を止めない。",
    targets: ["STRENGTH"],
    tags: ["補強", "定番"],
    defaultSets: 3,
    defaultDurationSeconds: 45,
    defaultRestSeconds: 30,
  },
  {
    name: "サイドプランク",
    nameKana: "さいどぷらんく",
    category: "CORE",
    metricType: "TIME",
    difficulty: 2,
    description: "横向きで前腕と足の側面で支える。",
    coachingPoint: "骨盤が後ろに落ちないよう真横を保つ。",
    targets: ["STRENGTH"],
    tags: ["補強"],
    defaultSets: 2,
    defaultDurationSeconds: 30,
    defaultRestSeconds: 30,
  },
  {
    name: "デッドバグ",
    nameKana: "でっどばぐ",
    category: "CORE",
    metricType: "REPS",
    difficulty: 2,
    description: "仰向けで対角の手脚を伸ばす。腰を床から浮かせない。",
    coachingPoint: "腰と床の隙間を潰したまま動かす。",
    targets: ["STRENGTH", "COORDINATION"],
    tags: ["補強"],
    defaultSets: 3,
    defaultReps: 10,
    defaultRestSeconds: 45,
  },

  // --- クールダウン ---
  {
    name: "クールダウンジョグ",
    nameKana: "くーるだうんじょぐ",
    category: "COOL_DOWN",
    metricType: "DISTANCE",
    difficulty: 1,
    description: "練習後の低強度走。",
    coachingPoint: "呼吸が完全に落ち着くまで。",
    targets: ["RECOVERY"],
    tags: ["定番"],
    defaultDistanceMeters: 1000,
  },
  {
    name: "静的ストレッチ",
    nameKana: "せいてきすとれっち",
    category: "COOL_DOWN",
    metricType: "TIME",
    difficulty: 1,
    description: "主要筋群を 20〜30 秒ずつ伸ばす。",
    coachingPoint: "痛みが出ない範囲で。呼吸を続ける。",
    targets: ["MOBILITY", "RECOVERY"],
    tags: ["定番"],
    defaultDurationSeconds: 600,
  },
];

/** メニュー雛形。exerciseName で上で作った種目を引く。 */
const MENUS = [
  {
    name: "短距離｜スピード日（火曜）",
    purpose: "最高速度の向上。神経系への高強度刺激を、疲労を溜めずに入れる。",
    phase: "PREPARATION",
    status: "REVIEWED",
    tags: ["短距離", "スピード"],
    blocks: [
      {
        name: "ウォームアップ",
        items: [
          { exerciseName: "ジョグ", distanceMeters: 1200 },
          { exerciseName: "動的ストレッチ", durationSeconds: 600 },
          { exerciseName: "ハードルドリル（またぎ越し）", sets: 2, reps: 6 },
        ],
      },
      {
        name: "ドリル",
        items: [
          { exerciseName: "Aスキップ", sets: 2, distanceMeters: 30, restSeconds: 60 },
          { exerciseName: "Bスキップ", sets: 2, distanceMeters: 30, restSeconds: 60 },
          { exerciseName: "ウィンドスプリント（流し）", sets: 3, distanceMeters: 80, restSeconds: 120 },
        ],
      },
      {
        name: "主運動",
        items: [
          {
            exerciseName: "加速走",
            sets: 4,
            distanceMeters: 60,
            restSeconds: 360,
            intensityPercent: 95,
            note: "助走 20m。フィニッシュまで力まない。",
          },
        ],
      },
      {
        name: "補強",
        items: [
          { exerciseName: "ノルディックハムストリング", sets: 3, reps: 5, restSeconds: 90 },
          { exerciseName: "プランク", sets: 3, durationSeconds: 45, restSeconds: 30 },
        ],
      },
      {
        name: "クールダウン",
        items: [
          { exerciseName: "クールダウンジョグ", distanceMeters: 1000 },
          { exerciseName: "静的ストレッチ", durationSeconds: 600 },
        ],
      },
    ],
  },
  {
    name: "短距離｜スピード持久日（木曜）",
    purpose: "レース後半の減速を抑える。乳酸耐性を高める。",
    phase: "PRE_COMPETITION",
    status: "REVIEWED",
    tags: ["短距離", "きつい"],
    blocks: [
      {
        name: "ウォームアップ",
        items: [
          { exerciseName: "ジョグ", distanceMeters: 1600 },
          { exerciseName: "動的ストレッチ", durationSeconds: 600 },
          { exerciseName: "Aスキップ", sets: 2, distanceMeters: 30 },
        ],
      },
      {
        name: "主運動",
        items: [
          {
            exerciseName: "レぺティション 150m",
            sets: 4,
            distanceMeters: 150,
            restSeconds: 480,
            intensityPercent: 90,
            note: "設定 18.5 秒。2 本目以降で 0.5 秒以上落ちたら終了。",
          },
        ],
      },
      {
        name: "クールダウン",
        items: [
          { exerciseName: "クールダウンジョグ", distanceMeters: 1200 },
          { exerciseName: "静的ストレッチ", durationSeconds: 600 },
        ],
      },
    ],
  },
  {
    name: "全体｜ウエイト＋補強（金曜）",
    purpose: "下肢の最大筋力と、傷害予防のための補強。",
    phase: "PREPARATION",
    status: "DRAFT",
    tags: ["ウエイト", "補強"],
    blocks: [
      {
        name: "ウォームアップ",
        items: [
          { exerciseName: "ジョグ", distanceMeters: 800 },
          { exerciseName: "動的ストレッチ", durationSeconds: 480 },
        ],
      },
      {
        name: "主運動",
        items: [
          { exerciseName: "バックスクワット", sets: 4, reps: 5, loadKg: 80, restSeconds: 180 },
          { exerciseName: "ルーマニアンデッドリフト", sets: 3, reps: 8, loadKg: 60, restSeconds: 120 },
          { exerciseName: "ボックスジャンプ", sets: 3, reps: 6, restSeconds: 90 },
        ],
      },
      {
        name: "補強",
        items: [
          { exerciseName: "デッドバグ", sets: 3, reps: 10 },
          { exerciseName: "サイドプランク", sets: 2, durationSeconds: 30 },
        ],
      },
      { name: "クールダウン", items: [{ exerciseName: "静的ストレッチ", durationSeconds: 480 }] },
    ],
  },
];

async function tagId(name: string, kind: string) {
  const tag = await prisma.tag.upsert({
    where: { kind_name: { kind, name } },
    update: {},
    create: { kind, name },
  });
  return tag.id;
}

async function main() {
  console.log("🌱 seeding...");

  // 既存データを消してから入れ直す（開発用シードのため）
  await prisma.exerciseDraft.deleteMany();
  await prisma.analysisJob.deleteMany();
  await prisma.videoAsset.deleteMany();
  await prisma.trainingSession.deleteMany();
  await prisma.menuTemplate.deleteMany();
  await prisma.exercise.deleteMany();
  await prisma.tag.deleteMany();

  const byName = new Map<string, string>();

  for (const e of EXERCISES) {
    const generalIds = await Promise.all((e.tags ?? []).map((t) => tagId(t, "GENERAL")));
    const equipIds = await Promise.all((e.equipment ?? []).map((t) => tagId(t, "EQUIPMENT")));

    const created = await prisma.exercise.create({
      data: {
        name: e.name,
        nameKana: e.nameKana,
        description: e.description,
        coachingPoint: e.coachingPoint,
        commonMistake: e.commonMistake,
        category: e.category,
        metricType: e.metricType,
        difficulty: e.difficulty,
        defaultSets: e.defaultSets,
        defaultReps: e.defaultReps,
        defaultDistanceMeters: e.defaultDistanceMeters,
        defaultDurationSeconds: e.defaultDurationSeconds,
        defaultRestSeconds: e.defaultRestSeconds,
        source: "MANUAL",
        status: "REVIEWED",
        targets: { create: e.targets.map((target) => ({ target })) },
        tags: { create: [...generalIds, ...equipIds].map((id) => ({ tagId: id })) },
      },
    });
    byName.set(e.name, created.id);
  }
  console.log(`  ✓ 種目 ${EXERCISES.length} 件`);

  const menuIds: string[] = [];
  for (const m of MENUS) {
    const tagIds = await Promise.all(m.tags.map((t) => tagId(t, "GENERAL")));
    const menu = await prisma.menuTemplate.create({
      data: {
        name: m.name,
        purpose: m.purpose,
        phase: m.phase,
        status: m.status,
        tags: { create: tagIds.map((id) => ({ tagId: id })) },
        blocks: {
          create: m.blocks.map((b, bi) => ({
            name: b.name,
            sortOrder: bi,
            items: {
              create: b.items.map((it, ii) => {
                const { exerciseName, ...rest } = it as typeof it & { exerciseName: string };
                return {
                  exerciseId: byName.get(exerciseName) ?? null,
                  sortOrder: ii,
                  ...rest,
                };
              }),
            },
          })),
        },
      },
    });
    menuIds.push(menu.id);
  }
  console.log(`  ✓ メニュー ${MENUS.length} 件`);

  // 直近のセッションを 1 件、テンプレートから展開して作っておく
  const source = await prisma.menuTemplate.findUnique({
    where: { id: menuIds[0] },
    include: {
      blocks: {
        orderBy: { sortOrder: "asc" },
        include: {
          items: { orderBy: { sortOrder: "asc" }, include: { exercise: { select: { name: true } } } },
        },
      },
    },
  });

  if (source) {
    let sortOrder = 0;
    const date = new Date();
    date.setDate(date.getDate() - 2);

    await prisma.trainingSession.create({
      data: {
        title: source.name,
        date,
        sourceMenuTemplateId: source.id,
        sourceMenuNameSnapshot: source.name,
        groupName: "短距離ブロック",
        location: "第一競技場",
        weather: "晴れ",
        condition: "気温 22℃ / 追い風 1.2m",
        status: "COMPLETED",
        coachNote:
          "加速走は 3 本目まで良好。4 本目で上体が起きるのが早くなったため打ち切り。次回は本数を 3 本に。",
        items: {
          create: source.blocks.flatMap((block) =>
            block.items.map((item) => ({
              exerciseId: item.exerciseId,
              exerciseNameSnapshot: item.exercise?.name ?? item.displayName ?? "（名称未設定）",
              blockNameSnapshot: block.name,
              sortOrder: sortOrder++,
              plannedSets: item.sets,
              plannedReps: item.reps,
              plannedDistanceMeters: item.distanceMeters,
              plannedDurationSeconds: item.durationSeconds,
              plannedRestSeconds: item.restSeconds,
              plannedIntensityPercent: item.intensityPercent,
              plannedNote: item.note,
              done: true,
              actualSets: item.sets,
            })),
          ),
        },
      },
    });
    console.log("  ✓ セッション 1 件");
  }

  console.log("✅ done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
