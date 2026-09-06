// HYK-431 1R (coder-task.md §2⑶) -- 가용 메모리 관측만 하는 어댑터.
// judgeReclaimAnomaly(seat-reclaim-core.mjs)가 요구하는
// { availableMemoryBytes, observable } 봉투를 Node 내장 os 모듈로 채운다.
// 판정 로직은 0(순수 코어에만 있다) -- 이 파일은 os.freemem()을 부르고
// 실패하면 observable:false로 접는 것뿐이다(teardown-inventory-adapter.mjs
// 와 동형: 관측 전용, 파괴 argv 0).
import { freemem } from "node:os";

// observeSystemPressure() -- 부작용: os.freemem() 호출(읽기 전용 syscall,
// 프로세스/파일 상태를 바꾸지 않는다). 실패(드묾 -- freemem은 보통
// 던지지 않지만, 방어적으로 감싼다)하면 observable:false, 값은 null.
export function observeSystemPressure() {
  try {
    const bytes = freemem();
    if (!Number.isFinite(bytes) || bytes < 0) {
      return { availableMemoryBytes: null, observable: false };
    }
    return { availableMemoryBytes: bytes, observable: true };
  } catch {
    return { availableMemoryBytes: null, observable: false };
  }
}
