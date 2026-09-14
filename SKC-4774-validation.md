SKC-4774 구현·검증 기록 (2026-09-14)

기준 커밋: `cf261a9bf`. 현재 `vk/71df-gpt6-skc-4774-summaries-서브에이전트-히스토리-전량-스` 브랜치의 로컬 변경이다.

| 파일 | 변경 이유 |
| --- | --- |
| `crates/utils/src/msg_store.rs` | 읽기 잠금 아래 빌린 역순 이터레이터를 전달하는 `with_history` 접근자만 추가. |
| `crates/executors/src/logs/mod.rs` | 최신 비어 있지 않은 TODO에서 탐색 종료. 일반 메시지는 값만 검사하고, TODO 후보만 기존 스키마·경로를 검증. 회귀 테스트와 재현 가능한 전·후 벤치 추가. |
| `crates/executors/src/logs/utils/patch.rs` | 기존 patch 값을 직접 읽어 `to_value`와 JSON 트리 복제를 제거. 여러 operation 중 마지막 유효 normalized entry를 선택하는 동작 유지. |
| `crates/server/src/routes/workspaces/workspace_summary.rs` | running 프로세스의 TODO를 `with_history`로 조회. `archived: null` 요청에서 active·archived 결과를 합침. 기존 boolean 필터 요청도 지원. |
| `crates/server/src/routes/execution_processes.rs` | transcript·stop의 소유권 확인과 프롬프트 복원에 캐시된 부모 이벤트 사용. 클라이언트 output 경로는 계속 신뢰하지 않음. |
| `crates/server/src/routes/execution_processes/subagent_log_cache.rs` | 프로세스 ID별 파일 오프셋·파싱 결과 캐시. 부분 JSONL/UTF-8/stdout 청크, 파일 축소·교체, 캐시 상한·프로세스 격리를 검증. |
| `packages/web-core/src/shared/hooks/useWorkspaces.ts` | 로컬 목록·리모트 목록·다른 호스트 스냅샷 각각에서 summaries 요청을 2회에서 1회로 통합. 기존 active/archived 소비자의 Map 조회와 정렬 유지. |
| `packages/web-core/src/shared/hooks/workspaceSummaryKeys.ts` | summaries 캐시 키를 호스트 단위로 통합. |
| `packages/web-core/src/shared/providers/WorkspaceProvider.tsx` | 읽음 표시가 통합 캐시를 갱신하도록 변경. |
| `packages/web-core/src/shared/hooks/useWorkspaces.test.ts` | 로컬·리모트 전송 대상과 단일 요청, 두 목록의 기존 summary 필드 유지 검증. |
| `shared/types.ts` | `pnpm run generate-types`로 요청의 nullable archived 타입 재생성. |

`packages/local-web/src/routes/_app.tsx`와 `packages/remote-web/src/routes/__root.tsx` 모두 shared `WorkspaceProvider`를 사용한다. 두 셸의 alias도 `packages/web-core/src`를 가리킨다. 셸 수정 없이 로컬의 `useWorkspaces`/호스트 스냅샷과 리모트의 `useRemoteHostWorkspaceStream`에 모두 적용된다.

측정 환경은 macOS arm64, 기본 debug test profile이다. 형제 이슈 빌드가 함께 실행되는 환경에서 측정했다. running 프로세스에 대응하는 `MsgStore` 5개에 각각 normalized entry 10,000개(본문 1,024바이트)와 stdout 10,000개(256바이트)를 넣었다. 최근 TODO 조건에는 마지막 TODO 뒤 stdout 100개를 추가했다. 워밍업 3회 후 30회 측정의 nearest-rank p95이며, 한 샘플에 5개 store의 조회가 모두 포함된다.

기준 함수 `legacy_progress`는 기준 커밋의 전체 history clone·전방 순회·patch `to_value` 경로를 재현한다. 같은 프로세스와 데이터에서 전·후를 측정하며 모든 샘플의 TODO 결과가 동일함을 assert한다.

| TODO 추출 조건 | 변경 전 p95 | 변경 후 p95 | 50ms 기준 |
| --- | ---: | ---: | --- |
| TODO 없음 | 589.921ms | 34.590ms | 통과 |
| 최근 TODO 있음 | 584.299ms | 0.079ms | 통과 |

첫 구현의 TODO 없음 조건은 712.204ms → 74.816ms로 기준을 넘었다. 일반 메시지의 patch 경로 검사를 TODO 후보에만 수행하도록 줄인 뒤 위와 같이 동일한 fixture·샘플 수로 재측정했다.

서브에이전트 부모 로그는 최초 810,172바이트를 읽은 후 변경 없는 폴링에서 0바이트를 읽는다. 분할 쓰기가 완료된 다음 폴링은 새 JSONL 레코드 105바이트만 읽었으며, 무관한 10,000개 이벤트를 제외하고 필요한 이벤트 2개를 보관했다. 검증 로그:

```text
SKC-4774 scenario=no_todo processes=5 normalized_entries_per_process=10000 raw_entries_per_process=10000 samples=30 before_p95_ms=589.921 after_p95_ms=34.590
SKC-4774 scenario=recent_todo processes=5 normalized_entries_per_process=10000 raw_entries_per_process=10000 samples=30 before_p95_ms=584.299 after_p95_ms=0.079
SKC-4774 parent-log tail: initial_bytes=810172 unchanged_poll_bytes=0 appended_bytes=105 retained_events=2
```

모든 cargo 실행과 cargo를 호출하는 pnpm 명령에 먼저 `export CARGO_TARGET_DIR=$HOME/.cache/vk-agents-target`를 적용했다.

| 실행 명령 | 결과 |
| --- | --- |
| `pnpm i` | 성공, lockfile 변경 없음 |
| `cargo test -p utils -p executors -p server -- --nocapture` | 348개 통과. 성능 벤치 1개와 기존 doctest 1개는 기본 실행에서 제외 |
| `cargo test -p executors summaries_todo_p95 --lib -- --ignored --nocapture` | 성능 벤치 별도 실행 통과, 위 p95 기록 |
| `cargo check --workspace` | 성공 |
| `cargo clippy -p utils -p executors -p server --all-targets -- -D warnings` | 성공 |
| `pnpm --filter @vibe/web-core run check` | 성공 |
| `pnpm --filter @vibe/web-core run test` | 117개 파일, 752개 테스트 통과 |
| `pnpm --filter @vibe/local-web run check` | 성공 |
| `pnpm --filter @vibe/remote-web run check` | 성공 |
| `pnpm run generate-types` | 성공. 변경된 생성물은 `shared/types.ts` |
| `pnpm --filter @vibe/local-web exec eslint --config .eslintrc.cjs ../web-core/src/shared/hooks/useWorkspaces.ts ../web-core/src/shared/hooks/workspaceSummaryKeys.ts ../web-core/src/shared/providers/WorkspaceProvider.tsx --report-unused-disable-directives --max-warnings 0` | 변경한 런타임 TS 파일 3개 성공 |
| `pnpm run format` | 성공 |
| `git diff --check` | 성공 |

캐시는 최대 32개 프로세스, 프로세스당 파싱 결과·대기 버퍼의 추정 메모리 2MiB, 미사용 10분 만료 정책을 사용한다. 상한을 넘는 결과는 응답에 포함하고 캐시 상태를 비워 다음 요청에서 다시 읽는다. 요청 취소 시에도 상한 적용 후 blocking task를 반환한다. 최초 조회·캐시 축출·파일 축소/교체 때는 처음부터 읽으며, 저장 실패나 아직 저장되지 않은 target의 확인에는 live stdout fallback을 유지한다.

위 50ms 검증 범위는 이슈에서 허용한 TODO 추출 함수이다. 실제 HTTP 핸들러 전체 p95, DB·git diff 비용, Claude/Codex provider E2E와 실제 UI는 측정하지 않았다. 릴리스 빌드·서버 기동·push·PR 생성·jh 병합은 수행하지 않았다.
