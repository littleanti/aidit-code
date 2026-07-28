// backend/bench/docker-isolation-poc.mjs
// 컨테이너 샌드박스 격리 PoC — **검증 전용. 실 코드에 반영하지 않는다.**
//
// 왜 이 파일이 있나:
//   현재 제품 실행 경로(`src/agent/toolExec.ts`)는 호스트에서 직접 셸을 띄우고, 격리는
//   ① 경로 가드(pathGuard) ② 프로세스 수·벽시계 타임아웃 ③ ENV 화이트리스트(XC-ENV) 까지다.
//   네트워크·메모리·CPU·PID 강제는 없다 — `src/sandbox/limits.ts` 가 "PoC 범위 밖"이라 정직히
//   적어둔 그대로다. 컨테이너 격리는 **실 서버 배포 시 운영자 담당**(README §6 · TRD §6.3).
//
//   이 스크립트는 그 결정을 바꾸지 않는다. 대신 "실 서버에서 무엇을 쓰면 실제로 막히는가"를
//   **측정해 남긴다**. 각 항목마다 호스트 실행(현행)과 컨테이너 실행(제안)을 나란히 돌려
//   격차를 수치화한다 — 주장이 아니라 대조 실험.
//
// 실행: cd backend && npm run bench:docker-poc
//   Docker 미설치/데몬 미가동이면 전체를 SKIP 으로 표시하고 실패로 위장하지 않는다.
//
// 결과: bench/out/docker-isolation.json

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out', 'docker-isolation.json');

/** 컨테이너 이미지 — 얇고 node 가 들어있는 공식 이미지. */
const IMAGE = process.env.POC_IMAGE || 'node:20-alpine';
/** 컨테이너 안에서 샌드박스 작업 디렉토리로 쓸 경로. */
const WORKDIR = '/work';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 실행 헬퍼 ─────────────────────────

/** 명령을 돌리고 { code, out } 을 돌려준다(합쳐진 stdout+stderr). */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? backendRoot,
      windowsHide: true,
      shell: opts.shell ?? false,
      env: opts.env,
    });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
        }, opts.timeoutMs)
      : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: out + String(e.message), killed });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, killed });
    });
  });
}

/**
 * 컨테이너 안에서 셸 명령을 돌린다. 격리 플래그가 이 함수의 본체다 —
 * 실 서버 구현 시 그대로 옮겨 쓸 수 있는 형태로 모아 둔다.
 */
function runInContainer(command, sandboxDir, flags = {}) {
  const args = [
    'run', '--rm',
    // (1) 네트워크 차단 — 기본값.
    ...(flags.network === 'open' ? [] : ['--network', 'none']),
    // (2) 샌드박스 디렉토리만 바인드. 호스트의 나머지는 애초에 보이지 않는다.
    '-v', `${sandboxDir}:${WORKDIR}`,
    '-w', WORKDIR,
    // (3) 루트 파일시스템 읽기전용 + 쓰기 가능한 tmpfs(/tmp). 작업 디렉토리는 바인드라 쓰기 가능.
    ...(flags.readOnly === false ? [] : ['--read-only', '--tmpfs', '/tmp:rw,size=16m']),
    // (4) 메모리 상한.
    '--memory', flags.memory ?? '256m',
    // OOM 시 스왑으로 회피하지 못하게 — memory-swap == memory.
    '--memory-swap', flags.memory ?? '256m',
    // (5) PID 상한 — fork bomb 차단.
    '--pids-limit', String(flags.pidsLimit ?? 64),
    // (6) CPU 쿼터.
    '--cpus', String(flags.cpus ?? 1),
    // 권한 상승 차단 + 모든 capability 제거.
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    IMAGE,
    'sh', '-c', command,
  ];
  return run('docker', args, { timeoutMs: flags.timeoutMs ?? 60_000 });
}

/** 현행 제품 경로와 동등한 호스트 실행(대조군). */
function runOnHost(command, sandboxDir) {
  const isWin = process.platform === 'win32';
  return run(isWin ? command : 'sh', isWin ? [] : ['-c', command], {
    cwd: sandboxDir,
    shell: isWin,
    timeoutMs: 60_000,
  });
}

// ───────────────────────── 검사 항목 ─────────────────────────

/**
 * 각 검사는 { id, 제목, 공격 명령, 판정 } 으로 구성된다.
 * `blocked(result)` 가 true 면 "격리가 막았다"는 뜻.
 */
const CHECKS = [
  {
    id: 'network-none',
    title: '아웃바운드 네트워크 차단',
    why: '샌드박스에서 임의 코드가 돈다 — 데이터 유출·SSRF·암호화폐 채굴의 1차 통로',
    // DNS 해석 자체가 실패해야 한다. 실패=차단.
    command:
      "node -e \"require('dns').promises.resolve4('example.com').then(a=>{console.log('RESOLVED',a[0]);process.exit(0)}).catch(e=>{console.log('BLOCKED',e.code);process.exit(9)})\"",
    blocked: (r) => r.code === 9 || /BLOCKED/.test(r.out),
  },
  {
    id: 'host-fs-scope',
    title: '샌드박스 밖 호스트 파일 접근 차단 (상대경로 탈출)',
    why:
      'pathGuard 는 FILE_* 도구의 relPath 인자만 검사한다. SHELL 명령 문자열 안의 `../` 는 ' +
      '검사 대상이 아니므로, 현행 호스트 실행에서는 셸 한 줄로 리포 파일을 읽을 수 있다',
    // 따옴표 중첩을 피해 cat 만 쓴다(이전 버전은 node -e 안의 " 가 깨져 양쪽 다 SyntaxError 였다).
    //   호스트: cwd=.poc-sandbox → ../package.json = backend/package.json → 읽힌다.
    //   컨테이너: cwd=/work → ../package.json = /package.json → 존재하지 않는다.
    command: 'cat ../package.json',
    // 패키지명이 출력에 없으면 못 읽은 것 = 차단.
    blocked: (r) => !/aidit-code-backend/.test(r.out),
  },
  {
    id: 'readonly-rootfs',
    title: '루트 파일시스템 쓰기 차단',
    why: '런타임 바이너리·설정 변조로 다음 세션을 오염시키는 경로를 끊는다',
    command:
      "node -e \"const fs=require('fs');try{fs.writeFileSync('/usr/local/pwned','x');console.log('WROTE')}catch(e){console.log('BLOCKED',e.code)}\"",
    blocked: (r) => /BLOCKED/.test(r.out) && !/WROTE/.test(r.out),
    // 호스트 대조군은 플랫폼 경로가 달라 의미가 없으므로 생략.
    hostSkip: 'Windows 호스트엔 /usr/local 이 없어 대조 의미 없음',
  },
  {
    id: 'workdir-writable',
    title: '작업 디렉토리는 여전히 쓰기 가능 (과잉 차단 아님)',
    why: '격리가 제품 기능(파일 생성)을 깨면 쓸 수 없다 — 반드시 함께 확인',
    command:
      "node -e \"const fs=require('fs');fs.writeFileSync('poc-ok.txt','ok');console.log('WROTE',fs.readFileSync('poc-ok.txt','utf8'))\"",
    // 여기서는 '막히지 않아야' 정상 — 판정 방향이 반대다.
    expectAllowed: true,
    blocked: (r) => !/WROTE ok/.test(r.out),
  },
  {
    id: 'memory-cap',
    title: '메모리 상한 강제 (OOM kill)',
    why: '한 세션이 호스트 메모리를 삼키면 모든 게시글의 SSE 가 함께 죽는다',
    // 256m 상한에서 1.5GB 를 잡으려 시도 → OOM 으로 비정상 종료해야 한다.
    command:
      "node -e \"const a=[];try{for(let i=0;i<1500;i++)a.push(Buffer.alloc(1024*1024,1));console.log('ALLOCATED')}catch(e){console.log('ALLOC_FAIL')}\"",
    blocked: (r) => !/ALLOCATED/.test(r.out),
    flags: { memory: '256m' },
  },
  {
    id: 'pids-limit',
    title: 'PID 상한 강제 (fork bomb 차단)',
    why: 'best-effort 카운터는 도구 호출 단위만 세고, 셸이 스스로 fork 하는 것은 못 막는다',
    // 300개를 띄우려 시도한 뒤 **실제로 살아있는 프로세스 수를 센다**.
    //   (이전 버전은 fork 실패 메시지를 2>/dev/null 로 버려 판정 근거가 사라졌다.)
    //   pids-limit=32 면 아무리 시도해도 32 근처에서 막힌다.
    command:
      'n=0; while [ $n -lt 300 ]; do sleep 10 & n=$((n+1)); done; echo PROCS $(ps -o pid= | wc -l)',
    // 차단 증거는 두 형태 중 하나로 나타난다:
    //   (a) 셸이 fork 자체를 못 해 `can't fork` 로 죽는다 — 상한이 걸린 가장 직접적인 증거.
    //       (실측: exit 2, "sh: can't fork: Resource temporarily unavailable" — echo 에 도달조차 못 한다.)
    //   (b) 끝까지 돌았지만 살아있는 프로세스 수가 상한 근처에서 멈춘다.
    // 둘 중 아무것도 없으면(300개가 다 떠서 PROCS 가 크면) 차단 실패다.
    blocked: (r) => {
      if (/can't fork|Resource temporarily unavailable/i.test(r.out)) return true;
      const m = /PROCS\s+(\d+)/.exec(r.out);
      if (!m) return false; // 셀 수도, fork 실패를 볼 수도 없었으면 차단됐다고 주장하지 않는다.
      return Number(m[1]) <= 40; // 상한 32 + 셸/ps 자신 등 여유
    },
    flags: { pidsLimit: 32 },
    hostSkip: '호스트에서 300 프로세스 fork 는 개발 머신에 위험 — 의도적으로 미실행',
  },
  {
    id: 'cpu-quota',
    title: 'CPU 쿼터 적용',
    why: '무한 루프 한 개가 코어를 독점하면 다른 세션의 응답이 굶는다',
    // busy loop 2초. 쿼터가 걸리면 벽시계 대비 소비 CPU 시간이 적어진다(측정만, 판정은 관용적).
    command:
      "node -e \"const t=Date.now();let x=0;while(Date.now()-t<2000)x++;const u=process.cpuUsage();console.log('CPU_US',u.user+u.system)\"",
    measureOnly: true,
    flags: { cpus: 0.5 },
  },
  {
    id: 'timeout-kill',
    title: '벽시계 타임아웃 시 컨테이너 강제 종료·정리',
    why: '--rm 과 kill 이 함께 동작해야 좀비 컨테이너가 쌓이지 않는다',
    command: 'sleep 30; echo SHOULD_NOT_PRINT',
    blocked: (r) => r.killed === true && !/SHOULD_NOT_PRINT/.test(r.out),
    flags: { timeoutMs: 3000 },
    hostSkip: '호스트 타임아웃은 이미 limits.ts + toolTimeout.test.ts 로 검증됨',
  },
];

// ───────────────────────── 오케스트레이션 ─────────────────────────

async function dockerAvailable() {
  const v = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  if (v.code !== 0) return { ok: false, reason: v.out.trim().split('\n').slice(-1)[0] };
  return { ok: true, version: v.out.trim() };
}

async function ensureImage() {
  const has = await run('docker', ['image', 'inspect', IMAGE], { timeoutMs: 20_000 });
  if (has.code === 0) return true;
  console.log(`[poc] pulling ${IMAGE} …`);
  const pull = await run('docker', ['pull', IMAGE], { timeoutMs: 300_000 });
  if (pull.code !== 0) {
    console.error(`[poc] pull failed:\n${pull.out.slice(-500)}`);
    return false;
  }
  return true;
}

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true });
  const sandboxDir = path.join(backendRoot, '.poc-sandbox');
  await rm(sandboxDir, { recursive: true, force: true });
  await mkdir(sandboxDir, { recursive: true });

  const report = {
    image: IMAGE,
    platform: process.platform,
    note: '검증 전용 PoC — backend/src 는 수정하지 않는다. 컨테이너 격리는 실 서버 배포 담당.',
    docker: null,
    checks: [],
  };

  const avail = await dockerAvailable();
  report.docker = avail;
  if (!avail.ok) {
    console.log(`\n[SKIP] Docker 사용 불가 — ${avail.reason}`);
    console.log('       (실패가 아니라 미실행이다. 데몬을 켜고 다시 실행하면 된다.)');
    report.checks = CHECKS.map((c) => ({ id: c.id, title: c.title, status: 'SKIP' }));
    await writeFile(OUT, JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[poc] docker ${avail.version} · image ${IMAGE}`);
  if (!(await ensureImage())) {
    report.checks = CHECKS.map((c) => ({ id: c.id, title: c.title, status: 'SKIP', reason: 'image unavailable' }));
    await writeFile(OUT, JSON.stringify(report, null, 2));
    return;
  }

  for (const check of CHECKS) {
    process.stdout.write(`\n▶ ${check.title}\n`);

    // ── 컨테이너 실행 ──
    const t0 = Date.now();
    const contained = await runInContainer(check.command, sandboxDir, check.flags ?? {});
    const containedMs = Date.now() - t0;

    // ── 호스트 대조군 ──
    let host = null;
    let hostMs = null;
    if (!check.hostSkip) {
      const h0 = Date.now();
      host = await runOnHost(check.command, sandboxDir);
      hostMs = Date.now() - h0;
    }

    const row = {
      id: check.id,
      title: check.title,
      why: check.why,
      container: {
        exitCode: contained.code,
        killed: contained.killed,
        output: contained.out.trim().slice(0, 300),
        ms: containedMs,
      },
      host: check.hostSkip
        ? { skipped: check.hostSkip }
        : { exitCode: host.code, output: host.out.trim().slice(0, 300), ms: hostMs },
    };

    if (check.measureOnly) {
      row.status = 'MEASURED';
      const m = /CPU_US (\d+)/.exec(contained.out);
      const hm = host ? /CPU_US (\d+)/.exec(host.out) : null;
      row.containerCpuUs = m ? Number(m[1]) : null;
      row.hostCpuUs = hm ? Number(hm[1]) : null;
      console.log(
        `   MEASURED  컨테이너 CPU ${row.containerCpuUs ?? '?'}µs` +
          (row.hostCpuUs != null ? ` vs 호스트 ${row.hostCpuUs}µs` : ''),
      );
    } else if (check.expectAllowed) {
      const ok = !check.blocked(contained);
      row.status = ok ? 'PASS' : 'FAIL';
      console.log(`   ${row.status}  (허용되어야 정상) 컨테이너: ${ok ? '쓰기 성공' : '쓰기 실패'}`);
    } else {
      const containerBlocked = check.blocked(contained);
      const hostBlocked = host ? check.blocked(host) : null;
      row.containerBlocked = containerBlocked;
      row.hostBlocked = hostBlocked;
      row.status = containerBlocked ? 'PASS' : 'FAIL';
      console.log(
        `   ${row.status}  컨테이너: ${containerBlocked ? '차단됨 ✓' : '뚫림 ✗'}` +
          (hostBlocked === null
            ? `  | 호스트: SKIP(${check.hostSkip})`
            : `  | 호스트(현행): ${hostBlocked ? '차단됨' : '뚫림 ← 격차'}`),
      );
    }

    report.checks.push(row);
    await sleep(200);
  }

  // ── 요약 ──
  const pass = report.checks.filter((c) => c.status === 'PASS').length;
  const fail = report.checks.filter((c) => c.status === 'FAIL').length;
  const measured = report.checks.filter((c) => c.status === 'MEASURED').length;
  const gaps = report.checks.filter((c) => c.hostBlocked === false && c.containerBlocked === true);

  console.log('\n===== 요약 =====');
  console.log(`PASS ${pass} · FAIL ${fail} · MEASURED ${measured}`);
  console.log(`\n컨테이너가 막고 현행 호스트 실행이 못 막는 항목 ${gaps.length}건:`);
  for (const g of gaps) console.log(`  - ${g.title}`);

  report.summary = { pass, fail, measured, gapCount: gaps.length, gaps: gaps.map((g) => g.id) };
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);

  await rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
}

await main();
