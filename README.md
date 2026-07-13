# homebridge-nest-km81

Nest 온도조절기를 **Google SDM(Smart Device Management) 공식 API**로 HomeKit에 연결하는 Homebridge 플러그인. Homebridge 2.0 호환.

## 특징

- **공식 API** — 브라우저 쿠키 취출 없음. OAuth refresh token이 자동 갱신되어 토큰 만료로 손댈 일이 없습니다.
- **Pub/Sub 실시간 이벤트** — Nest 앱·스케줄 등 외부 변경이 수 초 내 HomeKit에 반영 (전용 구독, REST long-poll, 추가 의존성 0). 폴링(기본 30초)은 보정용으로 병행.
- **명령 grace + verify burst** — 명령 직후 UI 깜빡임 없음 (낙관 업데이트 + 반영 확인 폴링).
- **회복탄력성** — 기기 검색 무한 재시도(부팅 시 인터넷 부재 대응), 폴링 연속 실패/기기 오프라인 시 HomeKit '응답 없음' 표시, refresh token 폐기(invalid_grant) 감지 시 재승인 안내 + 백오프.
- Home Assistant 공식 Nest 통합과 같은 Google 프로젝트를 재사용해도 **토큰이 독립**이라 충돌하지 않습니다.

## 기능

- 현재 온도 / 설정 온도(0.5°C 스냅, 9–32°C) / 모드(기기가 지원하는 것만 노출: OFF/HEAT/COOL/AUTO) / 현재 습도 / 표시 단위
- 에코 모드 중 온도를 바꾸면 에코 자동 해제 후 설정 (SDM이 에코 중 설정온도 변경을 거부하는 것 대응)
- OFF 모드에서 온도를 설정하면 HEAT 자동 전환 (씬/자동화가 모드·온도를 동시에 보내는 경우 호환)
- 선택: 에코 ON/OFF 토글 서비스 (`showEcoSwitch`)

## 설치

```bash
npm i -g homebridge-nest-km81
```

또는 Homebridge UI에서 `homebridge-nest-km81` 검색.

## 설정

```jsonc
{
  "platforms": [
    {
      "platform": "NestKm81",
      "clientId": "<OAuth 클라이언트 ID>",
      "clientSecret": "<OAuth 클라이언트 시크릿>",
      "refreshToken": "<refresh token>",
      "projectId": "<Device Access 프로젝트 ID (UUID)>",
      "cloudProjectId": "<Google Cloud 프로젝트 ID — Pub/Sub용, 선택>",
      "pollingInterval": 30
    }
  ]
}
```

| 옵션 | 기본 | 설명 |
|---|---|---|
| `clientId` / `clientSecret` / `refreshToken` / `projectId` | (필수) | SDM 자격증명 (아래 참조) |
| `pollingInterval` | 30 | 폴링 주기(초, 최소 15) — SDM 쿼터 고려 |
| `enablePubSub` | true | 실시간 이벤트 사용 여부 |
| `cloudProjectId` | — | Pub/Sub용 Google Cloud 프로젝트 ID. 비우면 폴링만 사용 |
| `pubsubSubscription` | homebridge-nest-km81-sub | **이 플러그인 전용 구독** — 다른 컨슈머(HA 등)와 공유 금지(메시지를 서로 뺏어감) |
| `showEcoSwitch` | true | 액세서리 안에 에코 토글 서비스 표시 |
| `nameOverride` | — | 비우면 Nest에 설정된 이름/방 이름 사용 |

### 자격증명 얻기 (요약)

1. Google Cloud 프로젝트 + [Device Access](https://console.nest.google.com/device-access) 프로젝트(등록비 $5). Home Assistant용으로 이미 만들었다면 재사용 가능.
2. OAuth 클라이언트(웹 애플리케이션)에 리디렉션 URI `https://www.google.com` 추가.
3. 브라우저에서 접속해 승인:
   `https://nestservices.google.com/partnerconnections/<projectId>/auth?redirect_uri=https://www.google.com&access_type=offline&prompt=consent&client_id=<clientId>&response_type=code&scope=https://www.googleapis.com/auth/sdm.service https://www.googleapis.com/auth/pubsub`
4. 리다이렉트된 주소창의 `code`를 `https://oauth2.googleapis.com/token`에 교환(POST) → `refresh_token` 확보.
5. Pub/Sub 사용 시: SDM 이벤트 토픽에 연결된 **전용 구독**을 만들고 이름을 `pubsubSubscription`에 지정.

> OAuth 동의 화면이 **테스트** 상태면 refresh token이 7일마다 만료됩니다 — **프로덕션**으로 게시하세요.

## 동작 방식 (기술 노트)

- 상태 갱신 3채널: Pub/Sub(수 초) → 정규 폴링(30초, 보정) → 명령 후 verify burst(2.5/6/12초).
- 명령은 낙관 UI + grace(15초)로 즉시 반영 표시, 실패 시 롤백.
- 폴링 루프는 `setTimeout` + `finally` 재무장 — 실패해도 죽지 않음. 연속 3회 실패 또는 기기 OFFLINE이면 '응답 없음' 표시, 회복 시 자동 해제.
- `invalid_grant`(refresh token 폐기) 감지 시 로그에 재승인 절차를 1회 안내하고 30분 간격으로만 재시도.

## 릴리스 (개발자용)

`.github/workflows/publish.yml` — `v*` 태그 push 또는 workflow_dispatch로 npm 배포(`NPM_TOKEN` 시크릿 필요).
**`package.json`의 version이 곧 배포 버전** — 버전을 올리지 않고 publish하면 403(중복)으로 실패합니다.
변경 이력은 GitHub 커밋/태그를 참조하세요.

## 라이선스

MIT
