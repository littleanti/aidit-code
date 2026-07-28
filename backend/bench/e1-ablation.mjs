// backend/bench/e1-ablation.mjs
// EXPERIMENTS.md E1 — 직렬 실행기 Ablation: "락을 빼면 진짜로 깨지는가".
//
// 왜 필요한가: v2 의 안전 주장은 "부수효과를 직렬화해 동시 파일 쓰기 진입 0"이다. 락이 있을 때
//   위반이 0 이라는 것만으로는 부족하다 — **빼면 실제로 깨진다**는 대조가 있어야 "락이 장식이
//   아니다"가 증명된다. 이 스크립트가 그 대조 실험이다.
//
// 측정 층(설계 §E1 방침): 에이전트/LLM 스택을 통과시키지 않고 `executeTool`(FILE_WRITE) +
//   락 프리미티브를 **직접** 구동한다. E1 은 모델 행동이 아니라 **I/O 경합**을 재는 실험이므로
//   결정적 백엔드가 옳다. 서버·DB·SSE 노이즈가 제거돼 감도가 최대가 된다.
//
// 조작 변인: LOCK=on|off. off 는 **이 스크립트 안에서만** 락을 우회한다 —
//   제품 코드(`src/`)에 우회 경로를 만들지 않는다.
//
// 워크로드 W1(파일 원자성): 두 writer 가 **같은 파일**에 K회 전체 쓰기를 동시에 수행한다.
//   페이로드 = HEADER(writerId,seq) + 본문(패턴 반복) + FOOTER(본문 SHA-256)
//   → 스냅샷을 파싱해 ① 무결 ② 혼합(두 writer 마커 공존 = torn write) ③ 깨짐(체크섬 불일치)로 분류.
//
// 실행: cd backend && npm run bench:e1
//       SIZE_KIB=4096 K=80 node bench/e1-ablation.mjs   (감도 상향)

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile as writeOut, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { executeTool } from '../src/agent/toolExec.js';
import { withScopedSandboxLock, normalizeLockPath } from '../src/agent/sandboxLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out', 'e1-ablation.json');

/** 페이로드 본문 크기(KiB). 단일 write() 원자성에 가려지지 않도록 크게. */
const SIZE_KIB = Number(process.env.SIZE_KIB) || 1024;
/** writer 당 쓰기 횟수. */
const K = Number(process.env.K) || 50;
/** 동시 writer 수. */
const WRITERS = Number(process.env.WRITERS) || 2;
/** 검증 스냅샷 폴링 간격(ms). 0 이면 최종 파일만 검사. */
const POLL_MS = Number(process.env.POLL_MS) || 2;

const TARGET = 'x.txt';
const SBX_KEY = 'e1-sandbox';

/** HEADER/FOOTER 로 감싼 페이로드를 만든다. 본문은 writer·seq 로 결정적. */
function buildPayload(writerId, seq) {
  const line = `${writerId}:${seq}:${'ab'.repeat(32)}\n`; // 65B 단위 패턴
  const repeat = Math.ceil((SIZE_KIB * 1024) / line.length);
  const body = line.repeat(repeat);
  const sum = createHash('sha256').update(body).digest('hex');
  return `#HEADER ${writerId} ${seq}\n${body}#FOOTER ${sum}\n`;
}

/**
 * 스냅샷을 분류한다.
 *   intact  — 헤더 1개 + 푸터 1개 + 본문 체크섬 일치 + 본문 전체가 헤더의 writer 소유
 *   mixed   — 두 writer 의 마커가 공존(torn write — 서로 다른 쓰기가 뒤섞였다)
 *   broken  — 구조 파손(헤더/푸터 누락·중복) 또는 체크섬 불일치
 *   partial — 쓰기 진행 중 잘린 상태. 락 ON 에서도 나타날 수 있어 **위반으로 세지 않는다**
 *             (writeFile 은 truncate 후 기록하므로 '아직 다 안 쓴' 중간 상태는 정상이다).
 */
function classify(text) {
  const headers = [...text.matchAll(/^#HEADER (\S+) (\d+)$/gm)];
  const footers = [...text.matchAll(/^#FOOTER ([0-9a-f]{64})$/gm)];

  const writersSeen = new Set(headers.map((m) => m[1]));
  // 본문 라인의 writer 도 함께 본다(헤더는 하나인데 본문이 섞인 경우를 잡는다).
  for (const m of text.matchAll(/^(w\d+):\d+:/gm)) writersSeen.add(m[1]);

  if (writersSeen.size > 1 || headers.length > 1 || footers.length > 1) return 'mixed';
  if (headers.length === 0 || footers.length === 0) return 'partial';

  const h = headers[0];
  const bodyStart = h.index + h[0].length + 1;
  const f = footers[0];
  if (f.index < bodyStart) return 'broken';
  const body = text.slice(bodyStart, f.index);
  const sum = createHash('sha256').update(body).digest('hex');
  return sum === f[1] ? 'intact' : 'broken';
}

/** 한 writer 가 K회 전체 쓰기를 수행. lock=false 면 락을 우회한다. */
async function writer(root, writerId, useLock) {
  for (let seq = 0; seq < K; seq++) {
    const req = {
      kind: 'FILE_WRITE',
      name: 'write_file',
      relPath: TARGET,
      content: buildPayload(writerId, seq),
    };
    const exec = () => executeTool(root, req, () => {});
    if (useLock) {
      await withScopedSandboxLock(SBX_KEY, { mode: 'path', path: normalizeLockPath(TARGET) }, exec);
    } else {
      await exec(); // ← ablation: 락 우회
    }
  }
}

/** 쓰기가 도는 동안 파일을 반복 읽어 스냅샷마다 분류한다. */
async function watcher(abs, stop, counts) {
  const seen = new Set();
  for (;;) {
    if (stop.done) break;
    try {
      const text = await readFile(abs, 'utf8');
      // 같은 내용을 중복 집계하지 않도록 해시로 dedupe(스냅샷 '종류' 기준 집계).
      const key = createHash('sha1').update(text).digest('hex');
      if (!seen.has(key)) {
        seen.add(key);
        counts[classify(text)] = (counts[classify(text)] ?? 0) + 1;
      }
    } catch {
      /* 아직 파일 없음 / 일시적 읽기 실패 */
    }
    if (POLL_MS > 0) await new Promise((r) => setTimeout(r, POLL_MS));
    else break;
  }
}

async function runCondition(useLock) {
  const root = await mkdtemp(path.join(tmpdir(), `e1-${useLock ? 'on' : 'off'}-`));
  const abs = path.join(root, TARGET);
  const counts = { intact: 0, mixed: 0, broken: 0, partial: 0 };
  const stop = { done: false };

  const w = watcher(abs, stop, counts);
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => writer(root, `w${i}`, useLock)),
  );
  const ms = Date.now() - t0;
  stop.done = true;
  await w;

  // 최종 파일도 반드시 분류에 포함.
  let finalClass = 'missing';
  try {
    finalClass = classify(await readFile(abs, 'utf8'));
  } catch {
    /* noop */
  }

  await rm(root, { recursive: true, force: true });

  const snapshots = counts.intact + counts.mixed + counts.broken + counts.partial;
  const violations = counts.mixed + counts.broken;
  return {
    lock: useLock ? 'on' : 'off',
    writers: WRITERS,
    writesPerWriter: K,
    payloadKiB: SIZE_KIB,
    snapshotsClassified: snapshots,
    counts,
    violations,
    violationRate: snapshots ? Number((violations / snapshots).toFixed(4)) : 0,
    finalClass,
    wallMs: ms,
  };
}

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true });
  console.log(
    `[e1] writers=${WRITERS} K=${K} payload=${SIZE_KIB}KiB poll=${POLL_MS}ms — 같은 파일 동시 전체 쓰기`,
  );

  const REPEAT = Number(process.env.REPEAT) || 1;
  const results = [];
  for (const useLock of [true, false]) {
    // 반복 실행 후 합산 — 단일 런의 우연을 배제한다.
    const runs = [];
    for (let i = 0; i < REPEAT; i++) runs.push(await runCondition(useLock));
    const r = runs.reduce((acc, cur) => {
      if (!acc) return { ...cur, repeats: 1, finalClasses: [cur.finalClass] };
      for (const k of Object.keys(acc.counts)) acc.counts[k] += cur.counts[k];
      acc.snapshotsClassified += cur.snapshotsClassified;
      acc.violations += cur.violations;
      acc.wallMs += cur.wallMs;
      acc.repeats += 1;
      acc.finalClasses.push(cur.finalClass);
      return acc;
    }, null);
    r.violationRate = r.snapshotsClassified
      ? Number((r.violations / r.snapshotsClassified).toFixed(4))
      : 0;
    r.finalClass = r.finalClasses.join(',');
    results.push(r);
    console.log(
      `\n── LOCK=${r.lock} ──\n` +
        `  분류 스냅샷 ${r.snapshotsClassified}개: intact=${r.counts.intact} ` +
        `mixed=${r.counts.mixed} broken=${r.counts.broken} partial=${r.counts.partial}\n` +
        `  위반(mixed+broken) = ${r.violations} (${(r.violationRate * 100).toFixed(2)}%)  ` +
        `최종파일=${r.finalClass}  벽시계 ${r.wallMs}ms`,
    );
  }

  const on = results.find((r) => r.lock === 'on');
  const off = results.find((r) => r.lock === 'off');

  console.log('\n===== E1 판정 =====');
  console.log(`  LOCK=on  위반 ${on.violations}/${on.snapshotsClassified}`);
  console.log(`  LOCK=off 위반 ${off.violations}/${off.snapshotsClassified}`);
  let verdict;
  if (on.violations === 0 && off.violations > 0) {
    verdict = 'CONFIRMED — 락이 있으면 0, 빼면 깨진다(락은 장식이 아니다)';
  } else if (on.violations === 0 && off.violations === 0) {
    verdict =
      'INCONCLUSIVE — off 에서도 위반 0. 플랫폼 단일 write() 원자성에 가려진 것일 수 있다. ' +
      'SIZE_KIB 를 올려 재시도하거나, 그 사실 자체를 한계로 보고할 것.';
  } else {
    verdict = `UNEXPECTED — LOCK=on 에서 위반 ${on.violations}건. 락 구현을 조사해야 한다.`;
  }
  console.log(`\n  판정: ${verdict}`);

  await writeOut(OUT, JSON.stringify({ results, verdict }, null, 2));
  console.log(`\nwrote ${OUT}`);
}

await main();
