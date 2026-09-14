SKC-4774 구현·검증 기록 (2026-09-14)

기준 커밋: `cf261a9bf`. 현재 `vk/71df-gpt6-skc-4774-summaries-서브에이전트-히스토리-전량-스` 브랜치의 로컬 변경이다.

먼저 최초 구현(`387981ee4`)의 검증을 기록하고, 문서 하단에 후속 보완과 재검증 결과를 기록한다.

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

후속 보완: `387981ee4` 재검토에서 확인한 두 회귀를 수정했다.

- `subagent_log_cache.rs`: 같은 파일을 비우고 이전 오프셋보다 길게 다시 쓰는 경우, 파일 앞부분과 오프셋 직전의 최대 256바이트씩을 비교한다. 크기·수정 시간이 바뀐 경우에만 검사하며, 불일치하면 파싱 결과·부분 stdout·오프셋을 함께 초기화한다. 검사 버퍼도 메모리 상한에 포함한다. 앞부분 또는 끝부분만 같은 재작성과 이전 응답의 스냅샷 유지도 회귀 테스트에 포함했다.
- `useWorkspaces.ts`: 통합 요청이 422로 거절된 경우에만 기존 boolean 필터로 active·archived를 병렬 조회한다. 각 조회의 실패는 독립 처리하고 boolean 요청은 다시 재시도하지 않는다. 최신 호스트는 1회, 구버전 호스트는 거절된 요청 1회와 기존 조회 2회이며, 호스트를 업데이트하면 다음 폴링부터 다시 1회가 된다. 호스트·prompt 옵션은 모든 요청에 동일하게 전달한다.
- `useWorkspaces.test.ts`: 로컬·리모트 구버전 호환, 401/403/500에서 재시도하지 않음, 한 목록 실패 시 다른 목록 유지 테스트를 추가했다. 두 셸 모두 기존 shared `WorkspaceProvider`와 summaries 함수를 사용하므로 셸 변경 없이 적용된다.

로컬의 `host_relay::proxy`와 리모트의 WebRTC·relay 전송 경로도 확인했다. 이 경로들은 422 상태를 그대로 `Response`에 전달하므로 공통 함수의 호환 처리가 두 웹에 동일하게 적용된다.

수정 전에는 새 Rust 재작성 테스트 1개와 FE 호환 테스트 3개가 실패했다. 변경 후 검증 결과는 아래에 기록한다.

| 재검증 명령 | 결과 |
| --- | --- |
| `pnpm i` | 성공, lockfile 변경 없음 |
| `cargo test -p server subagent_log_cache --lib -- --nocapture` | 5개 통과. 재작성 테스트는 앞/끝 구간 변화 조합 3개를 검증 |
| `cargo test -p utils -p executors -p server -- --nocapture` | 349개 통과. 기존 성능 벤치와 doctest 각 1개는 기본 실행에서 제외 |
| `cargo check --workspace` | 성공 |
| `cargo clippy -p utils -p executors -p server --all-targets -- -D warnings` | 성공 |
| `cargo clean -p utils` 후 `pnpm run generate-types` | 공유 캐시 충돌 복구 후 성공. 생성 타입·스키마 변경 없음 |
| `pnpm --filter @vibe/web-core run check` | 성공 |
| `pnpm --filter @vibe/local-web run check` | 성공 |
| `pnpm --filter @vibe/remote-web run check` | 성공 |
| `pnpm --filter @vibe/web-core run test` | 117개 파일, 758개 테스트 통과 |
| `pnpm --filter @vibe/local-web exec eslint --config .eslintrc.cjs ../web-core/src/shared/hooks/useWorkspaces.ts --report-unused-disable-directives --max-warnings 0` | 성공 |
| `pnpm run format` | 성공 |

보완 후 긴 부모 로그의 측정 결과는 다음과 같다. 이전의 105바이트 읽기에 재작성 확인용 512바이트가 더해진다. 변경 없는 완결 로그는 0바이트 읽기를 유지한다. TODO 추출 경로는 이번 보완에서 변경하지 않았으며, 위 p95는 최초 구현 시 측정한 기록이다.

```text
SKC-4774 parent-log tail: initial_bytes=810172 unchanged_poll_bytes=0 appended_record_bytes=105 checkpoint_bytes=512 total_read_bytes=617 retained_events=2
```

보완 후 첫 타입 생성 시 공유 target에서 SKC-4772 워크트리의 `utils` 산출물이 재사용되어 `with_history`를 찾지 못했다. `cargo clean -p utils`로 해당 패키지 산출물 1.4GiB만 정리한 뒤 같은 `CARGO_TARGET_DIR`에서 재생성해 해결했다. 소스 수정 없이 재시도가 통과했으며, 형제 작업의 소스에는 변경을 가하지 않았다.

검사하는 두 구간을 모두 그대로 유지하며 중간 내용만 바꾸는 임의 편집은 이 방식으로 완전히 감지할 수 없다. 그런 편집까지 지원하려면 writer 세대 표식이 필요하다. 정상 append 판별 비용은 최대 512바이트이고, 재작성이 감지되면 새 로그를 처음부터 읽는다.
