import { useAuthStore } from '../stores/authStore';

// 재사용 터미널 프롬프트 줄(부모 Aidit 이식). 모든 주요 화면 상단에 렌더:
//   aidit@<user>:~$ <command> <blinking cursor>
//
// - <user> 는 authStore 의 username(없으면 'guest').
// - <command> 는 화면별 셸 명령(호출부가 최종 문자열을 넘김; 사용자 인자는 호출부가
//   formatPromptArg 등으로 직접 보간).
//
// 표현 전용: 라우터/i18n import 없음. 셸 명령은 터미널 관용구라 번역하지 않는다
// (KO/EN 동일). 전체 프롬프트 줄은 장식이라 root 에 aria-hidden — 각 화면의 실제
// 입력 필드가 접근성 소스 오브 트루스다. aria-live 없음.

interface ShellPromptProps {
  command: string;
  className?: string;
}

export default function ShellPrompt({ command, className }: ShellPromptProps) {
  const user = useAuthStore((s) => s.username) ?? 'guest';

  return (
    <div aria-hidden className={`text-xs text-term-faint ${className ?? ''}`}>
      aidit@{user}:~$ {command}{' '}
      <span className="term-cursor" />
    </div>
  );
}
