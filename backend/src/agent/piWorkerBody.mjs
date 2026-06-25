// backend/src/agent/piWorkerBody.mjs
// piWorker 의 /chat/completions 요청 body 구성 + 비전 user-content 구성의 순수 헬퍼.
// 부트스트랩 부작용(readline/stdout 'ready'/keepalive)이 없는 별도 모듈로 분리해 단위 테스트 가능하게 한다.
//
// 보안: 키/시크릿을 다루지 않는다(순수 변환만). reasoning_effort 는 reasoning 모델 전용 필드이며,
//   값이 있을 때만 포함한다(비지원 모델이 거부하지 않도록 — 없으면 생략).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 유효한 reasoning_effort 값(Feature B). 그 외(undefined 포함)는 필드 생략. */
export const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * 모델명이 reasoning 모델 패턴인지(공급자 프리픽스 `openai/` 등 허용).
 * o1~o9 계열(o3, o4-mini …)과 gpt-5 계열을 reasoning 으로 본다. gpt-4o/4o-mini 등은 제외.
 */
const REASONING_MODEL_RE = /(?:^|\/)(o[1-9](?:[-.]|$)|gpt-5)/i;

/**
 * 이 턴에 `reasoning_effort` 를 실제로 전송할지 결정한다(Feature B 안전 게이트).
 * 프런트가 aiMode 에서 항상 기본값(medium)을 보내므로, 비-reasoning 모델(예: gpt-4o-mini)에
 * 무조건 싣지 않도록 모델/환경으로 한 번 더 거른다 — 그렇지 않으면 400 회귀 위험.
 *   envOverride(REASONING_EFFORT): 'off'→미전송, 'on'→항상, 'auto'(기본)→모델이 reasoning 패턴일 때만.
 */
export function reasoningEffortApplies(model, effort, envOverride) {
  if (!(typeof effort === 'string' && REASONING_EFFORTS.has(effort))) return false;
  const ov = (typeof envOverride === 'string' ? envOverride : 'auto').toLowerCase();
  if (ov === 'off') return false;
  if (ov === 'on') return true;
  return REASONING_MODEL_RE.test(typeof model === 'string' ? model : '');
}

/** 허용 이미지 MIME(부모가 화이트리스트 통과한 값만 보내지만 워커도 방어적으로 검사). */
export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * /chat/completions 요청 body 를 구성한다(순수 함수 — 단위 테스트 대상).
 * reasoningEffort 가 유효(low/medium/high)할 때만 `reasoning_effort` 필드를 포함한다(없으면 생략).
 */
export function buildCompletionBody(messages, model, tools, reasoningEffort) {
  const body = {
    model,
    stream: true,
    tools,
    tool_choice: 'auto',
    messages,
  };
  if (typeof reasoningEffort === 'string' && REASONING_EFFORTS.has(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  }
  return body;
}

/**
 * 부모가 보낸 image {absPath, mime} 를 읽어 data-url 로 변환한다.
 * 경로 가드: absPath 가 uploadDir 내부일 때만 읽는다(.. / 외부 경로 거부 → null).
 * 실패(미존재/가드 위반/미허용 MIME/uploadDir 미주입)면 null.
 */
export async function imageToDataUrl(image, uploadDir) {
  if (!image || typeof image.absPath !== 'string' || typeof image.mime !== 'string') return null;
  const mime = image.mime.toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mime)) return null;
  if (!uploadDir) return null;
  const rootAbs = path.resolve(uploadDir);
  const abs = path.resolve(image.absPath);
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(withSep)) return null;
  try {
    const buf = await readFile(abs);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 사용자 user 메시지의 content 를 구성한다(Feature A 비전).
 *   - 이미지가 있고 읽기 성공 → multimodal 배열: [{type:'text',text},{type:'image_url',image_url:{url}}].
 *   - 이미지가 없거나 읽기 실패 → 기존 plain string content(동작 무변).
 */
export async function buildUserContent(prompt, image, uploadDir) {
  if (!image) return prompt;
  const dataUrl = await imageToDataUrl(image, uploadDir);
  if (!dataUrl) return prompt; // 가드 위반/읽기 실패 → 텍스트-only 폴백.
  return [
    { type: 'text', text: typeof prompt === 'string' ? prompt : '' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
}
