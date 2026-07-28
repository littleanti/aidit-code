// frontend/e2e/render-hol-clip.mjs
// docs/assets/hol-clip.html 을 실제 브라우저에서 재생·녹화해 심사 발표용 클립(mp4)을 만든다.
//
// 왜 브라우저 녹화인가: 클립의 수치는 **EXPERIMENTS §E2 실측값 상수**에서 나온다(임의 연출 없음).
//   두 계약을 실제 서버로 동시 촬영하면 실행마다 지연이 흔들려 클립 숫자와 논문 표가 어긋난다 —
//   그러면 오히려 신뢰를 깎는다. 데이터에서 결정적으로 생성해 **항상 같은 그림**을 얻는다.
//
// 산출물: docs/assets/hol-clip.mp4 (1280×720, ~19s, 무음)
// 실행: cd frontend && npm run clip:hol

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdir, rename, rm, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const HTML = path.join(repoRoot, 'docs', 'assets', 'hol-clip.html');
const OUT_DIR = path.join(repoRoot, 'docs', 'assets');
const OUT_MP4 = path.join(OUT_DIR, 'hol-clip.mp4');
const TMP = path.join(__dirname, '.clip-tmp');

const DURATION_MS = 19_500;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  console.log('[clip] 브라우저 녹화 시작 (1280×720, 약 20초)…');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: TMP, size: { width: 1280, height: 720 } },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(`file://${HTML.replace(/\\/g, '/')}`, { waitUntil: 'load' });
  // 애니메이션이 끝까지 돌 시간을 실시간으로 준다(1:1 — 시청자가 대기를 '느끼는' 것이 요점).
  await page.waitForTimeout(DURATION_MS);
  await ctx.close(); // 여기서 webm 이 flush 된다.
  await browser.close();

  const files = (await readdir(TMP)).filter((f) => f.endsWith('.webm'));
  if (!files.length) throw new Error('녹화 파일이 생성되지 않았다');
  const webm = path.join(TMP, files[0]);
  console.log(`[clip] webm ${(await stat(webm)).size} bytes → mp4 변환…`);

  // ffmpeg 로 mp4(H.264) 변환 — 발표 슬라이드/브라우저 호환.
  const ff = await run('ffmpeg', [
    '-y', '-i', webm,
    '-vf', 'fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-movflags', '+faststart',
    OUT_MP4,
  ]);
  if (ff.code !== 0) {
    console.error('[clip] ffmpeg 실패 — webm 을 그대로 남긴다:');
    console.error(ff.out.slice(-600));
    const fallback = path.join(OUT_DIR, 'hol-clip.webm');
    await rename(webm, fallback);
    console.log(`[clip] wrote ${fallback}`);
    return;
  }

  await rm(TMP, { recursive: true, force: true });
  const s = await stat(OUT_MP4);
  console.log(`[clip] wrote ${OUT_MP4} (${(s.size / 1024).toFixed(0)} KiB)`);
}

await main();
