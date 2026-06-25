#!/usr/bin/env node
// backend/scripts/key-grep-gate.mjs
// XC-REDACT CI 게이트(TRD §8 / CLAUDE.md L1).
//   커밋된 소스 트리에서 하드코딩된 "키 모양" 리터럴을 찾고, 발견되면 nonzero 로 종료한다.
//   탐지 대상:
//     - OpenAI 류 키: sk-[A-Za-z0-9]{16,}
//     - GitHub PAT: ghp_[A-Za-z0-9]{20,} (및 gho_/ghu_/ghs_/ghr_ 변종)
//     - 값이 붙은 raw 'API_KEY=' (예: API_KEY=sk-xxxx, OPENAI_API_KEY="..."). 빈 값/플레이스홀더는 허용.
//   제외:
//     - node_modules, .git, dist, build, coverage
//     - .env / .env.* (운영 비밀은 .env 에만 존재 — 이것이 정상; 단 .env.example 은 플레이스홀더만 허용)
//     - 테스트 SENTINEL(문자열에 'SENTINEL' 포함) — 의도된 누출-탐지 픽스처.
//
//   사용: node backend/scripts/key-grep-gate.mjs   (또는 npm run keygate)
//   레포 루트에서 backend/ 를 스캔한다(다른 레인 소스도 함께 게이트).

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/scripts → backend → repo root.
const repoRoot = path.resolve(__dirname, '..', '..');

// 스캔 루트(레포 전체. node_modules 등은 아래에서 제외).
const SCAN_ROOTS = [repoRoot];

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.sandboxes',
  '.omc',
]);

// 텍스트로 스캔할 확장자(바이너리/락파일 제외).
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css',
  '.sh', '.env-sample', '.example',
]);

// 키 모양 패턴.
//   openai-key / github-pat 은 "실제 키처럼 보이는" 리터럴을 직접 탐지한다.
//   assigned-api-key 는 'API_KEY = <값>' 형태에서 값이 *실제 비밀처럼 보일 때만* 보고한다
//     (코드 식별자 참조 rt.apiKey, 플레이스홀더 REPLACE_ME, 테스트 목 'super-secret-value' 등은 제외).
const PATTERNS = [
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{16,}/g },
  { name: 'github-pat', re: /gh[opusr]_[A-Za-z0-9]{20,}/g },
  // 값이 붙은 API_KEY 할당. capture[1] = 값(따옴표 안/밖). 아래에서 비밀 모양만 통과.
  { name: 'assigned-api-key', re: /\b[A-Z0-9_]*API_KEY\s*[=:]\s*(?:'([^']*)'|"([^"]*)"|([^\s'",#}]+))/g },
];

/** 실제 비밀처럼 보이는 값인지(opaque 토큰/공급자 프리픽스). */
function looksLikeSecret(val) {
  if (!val) return false;
  const v = val.trim();
  // 공급자 프리픽스 키.
  if (/^sk-[A-Za-z0-9]{16,}$/.test(v)) return true;
  if (/^gh[opusr]_[A-Za-z0-9]{20,}$/.test(v)) return true;
  // 긴 opaque base64/hex 토큰(20+). 단 코드 식별자/플레이스홀더는 아래에서 별도 제외.
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) {
    // 반복 문자(xxxxx, REPLACE_ME 류)나 단어성 값은 비밀로 보지 않는다.
    if (/^(x+|0+|a+|REPLACE.*|EXAMPLE.*|DUMMY.*)$/i.test(v.replace(/[-_]/g, ''))) return false;
    return true;
  }
  return false;
}

/** 코드 식별자/표현식 참조인지(예: rt.apiKey, process.env.X, config.llm.apiKey). */
function isCodeReference(val) {
  if (!val) return true;
  const v = val.trim().replace(/[,;)}]+$/, '');
  // 점 접근/괄호/공백 포함 → 코드 표현식.
  if (/[.()\s]/.test(v)) return true;
  // 순수 식별자(영문 시작, 숫자 없음 가능) — 비밀 토큰이 아님.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v) && !/[0-9]/.test(v)) return true;
  return false;
}

/** 플레이스홀더/빈 값인지(게이트 통과 허용). */
function isPlaceholder(val) {
  if (!val) return true;
  const v = val.trim().toLowerCase();
  if (v.length === 0) return true;
  const placeholders = [
    'your_api_key', 'your-api-key', 'changeme', 'change-me', 'xxx', 'xxxx',
    'todo', 'placeholder', 'example', 'dummy', 'redacted', '<your',
    'sk-xxx', 'sk-...', '...', 'process.env', 'replace_me', 'replace-me',
    'super-secret-value', 'secret-value',
  ];
  return placeholders.some((p) => v.includes(p));
}

/** 테스트 SENTINEL 픽스처인지(의도된 누출-탐지 문자열). */
function isTestSentinel(matchText) {
  return /SENTINEL/i.test(matchText);
}

/** .env / .env.* 경로인지. .env.example 은 플레이스홀더만 허용하므로 별도 취급. */
function isDotenv(relPath) {
  const base = path.basename(relPath);
  return base === '.env' || base.startsWith('.env.');
}

/** 디렉토리를 재귀 순회하며 텍스트 파일 경로를 수집. */
async function collectFiles(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      await collectFiles(full, acc);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name);
      const base = path.basename(ent.name);
      // .env / .env.* 도 스캔 대상에 포함(단, .env 자체의 실제 비밀은 정상 위치이므로 아래에서 스킵).
      if (TEXT_EXT.has(ext) || base.startsWith('.env')) {
        acc.push(full);
      }
    }
  }
}

async function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    // 디렉토리만 순회.
    try {
      const s = await stat(root);
      if (s.isDirectory()) await collectFiles(root, files);
    } catch {
      /* noop */
    }
  }

  const findings = [];
  // 이 게이트 스크립트 자신은 패턴 정의를 담고 있으므로 스캔에서 제외(자기 참조 오탐 방지).
  const selfPath = fileURLToPath(import.meta.url);

  for (const file of files) {
    if (path.resolve(file) === path.resolve(selfPath)) continue;
    const rel = path.relative(repoRoot, file);
    // 실제 운영 비밀은 .env 에만 존재하는 것이 정상 — .env(.local 등)는 게이트 대상에서 제외.
    // 단 .env.example 은 플레이스홀더만 허용하므로 계속 스캔한다.
    if (isDotenv(rel) && path.basename(rel) !== '.env.example') {
      continue;
    }

    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const { name, re } of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const matchText = m[0];
          if (isTestSentinel(matchText) || isTestSentinel(line)) continue;
          // 직접 키 패턴(openai-key/github-pat)도 명백한 플레이스홀더는 통과
          //   (문서 예시: ghp_xxxxx..., sk-xxxx..., 단일문자 반복 등).
          if (name === 'openai-key' || name === 'github-pat') {
            const body = matchText.replace(/^(sk-|gh[opusr]_)/, '');
            // 본문이 단일 문자 반복(xxxx/0000/aaaa)이거나 'x' 비중이 매우 높으면 플레이스홀더.
            if (/^(.)\1{7,}$/.test(body)) continue;
            const xRatio = (body.match(/x/gi) || []).length / body.length;
            if (xRatio > 0.6) continue;
            if (isPlaceholder(matchText)) continue;
          }
          if (name === 'assigned-api-key') {
            // capture[1|2|3] = 작은따옴표/큰따옴표/무따옴표 값.
            const captured = m[1] ?? m[2] ?? m[3] ?? '';
            if (isPlaceholder(captured)) continue;
            if (isCodeReference(captured)) continue; // rt.apiKey, process.env.X 등.
            if (!looksLikeSecret(captured)) continue; // 비밀 모양이 아니면 통과.
          }
          findings.push({
            file: rel,
            line: i + 1,
            rule: name,
            text: matchText.length > 80 ? matchText.slice(0, 80) + '…' : matchText,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('✗ key-grep-gate FAILED — hardcoded key-shaped literal(s) found:');
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
    }
    console.error(
      '\nKeys must live ONLY in server .env (and be injected as child ENV). ' +
        'See docs/checklists/key-blind.md.',
    );
    process.exit(1);
  }

  console.log(`✓ key-grep-gate passed — scanned ${files.length} file(s), no hardcoded keys found.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('key-grep-gate crashed:', err);
  process.exit(2);
});
