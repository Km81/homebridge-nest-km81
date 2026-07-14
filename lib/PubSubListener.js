'use strict';

/**
 * PubSubListener — SDM 이벤트 실시간 수신 (v1.1.0)
 *
 * Google Pub/Sub REST long-poll(pull) 루프. gRPC streamingPull 대신 REST를 쓰는 이유:
 * 의존성 0(내장 fetch)·기기 1대 규모에 충분·홈브릿지 환경에서 단순함이 곧 견고함.
 *
 * - HA의 구독(home-assistant-nest-sub)과 **별도 구독**을 사용한다 — 같은 구독을 두
 *   컨슈머가 공유하면 메시지를 서로 뺏어가 둘 다 상태 갱신이 누락된다.
 * - at-least-once: ack 실패나 처리 누락은 정규 폴링(reconciliation)이 보정하므로
 *   ack를 먼저 보내고 처리한다(중복 이벤트는 상태 머지가 멱등이라 무해).
 * - 토큰은 SdmClient의 것을 공유(같은 refresh token, pubsub 스코프 포함).
 */

const PUBSUB_BASE = 'https://pubsub.googleapis.com/v1';
const PULL_TIMEOUT_MS = 40000;                 // long-poll 대기(서버 hold 포함)보다 길게
const EMPTY_IDLE_MS = 1000;                    // 빈 응답 즉시 반환 시 핫루프 방지
const ERROR_BACKOFF_MS = [5000, 15000, 60000, 300000];

class PubSubListener {
  constructor({ sdm, cloudProjectId, subscription, log, onEvent }) {
    this.sdm = sdm;
    this.base = `${PUBSUB_BASE}/projects/${cloudProjectId}/subscriptions/${subscription}`;
    this.log = log;
    this.onEvent = onEvent;
    this._stopped = false;
    this._ac = null;
    this._errStreak = 0;
    this._gotFirst = false;
  }

  start() {
    this._stopped = false;
    this._loop().catch((e) => {
      // _loop은 내부에서 전부 삼키므로 여기 도달하면 버그 — 로그만 남김 (홈브릿지는 죽지 않음)
      this.log.error(`[PubSub] 루프 이탈(버그): ${e.message || e}`);
    });
    this.log.info('[PubSub] 실시간 이벤트 수신 시작 (구독: 전용 homebridge-nest-km81-sub)');
  }

  stop() {
    this._stopped = true;
    if (this._ac) { try { this._ac.abort(); } catch (_) {} }
  }

  async _sleep(ms) {
    return new Promise((r) => { this._sleepTimer = setTimeout(r, ms); });
  }

  async _pubsub(pathSuffix, bodyObj) {
    const tok = await this.sdm._accessToken();
    const ac = new AbortController();
    this._ac = ac;
    const t = setTimeout(() => ac.abort(), PULL_TIMEOUT_MS);
    try {
      const r = await fetch(this.base + pathSuffix, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal: ac.signal,
      });
      const body = await r.text();
      if (!r.ok) throw new Error(`${pathSuffix} HTTP ${r.status}: ${body.slice(0, 200)}`);
      return body ? JSON.parse(body) : {};
    } finally {
      clearTimeout(t);
      this._ac = null;
    }
  }

  async _loop() {
    while (!this._stopped) {
      try {
        const j = await this._pubsub(':pull', { maxMessages: 100 });
        const msgs = j.receivedMessages || [];
        if (this._warnedErr) {
          this.log.info(`[PubSub] 수신 회복됨 (오류 ${this._errStreak}회 후 정상화)`);
          this._warnedErr = false;
        }
        this._errStreak = 0;

        if (msgs.length) {
          // ack 먼저 (at-least-once — 처리 실패는 정규 폴링이 보정)
          this._pubsub(':acknowledge', { ackIds: msgs.map((m) => m.ackId) })
            .catch(() => { /* ack 실패 → 재전달 → 멱등 머지라 무해 */ });
          if (!this._gotFirst) {
            this._gotFirst = true;
            this.log.info('[PubSub] 첫 이벤트 수신 — 실시간 반영 동작 확인');
          }
          for (const m of msgs) {
            try {
              const data = JSON.parse(Buffer.from(m.message.data, 'base64').toString('utf8'));
              this.onEvent(data);
            } catch (_) { /* 형식 밖 메시지 무시 */ }
          }
        } else {
          await this._sleep(EMPTY_IDLE_MS);
        }
      } catch (e) {
        if (this._stopped) return;
        const delay = ERROR_BACKOFF_MS[Math.min(this._errStreak, ERROR_BACKOFF_MS.length - 1)];
        this._errStreak++;
        if (this._errStreak === 1 || this._errStreak % 10 === 0) {
          this.log.warn(`[PubSub] 수신 오류 x${this._errStreak}: ${e.message || e} — ${Math.round(delay / 1000)}초 후 재시도 (그동안 정규 폴링으로 동작)`);
          this._warnedErr = true;
        }
        await this._sleep(delay);
      }
    }
  }
}

module.exports = PubSubListener;
