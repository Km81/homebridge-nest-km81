'use strict';

/**
 * SdmClient — Google Smart Device Management(SDM) 공식 API 클라이언트.
 *
 * homebridge-nest(비공식 소비자 API + 브라우저 쿠키 취출)의 대체:
 *  - OAuth refresh token으로 access token을 자동 무한 갱신 → 토큰 만료로 손댈 일 없음.
 *  - HA(Home Assistant) 공식 Nest 통합과 같은 구글 클라우드 프로젝트/클라이언트를 재사용해도
 *    refresh token은 각자 독립 발급이라 서로 로그아웃시키지 않는다(ThinQ류 세션 충돌 없음).
 *
 * 표면:
 *   listDevices()                      → devices[] (raw SDM)
 *   getDevice(name)                    → device (raw SDM, name = 'enterprises/.../devices/...')
 *   executeCommand(name, command, p)   → SDM :executeCommand
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SDM_BASE = 'https://smartdevicemanagement.googleapis.com/v1';
const FETCH_TIMEOUT_MS = 10000;       // 네트워크 호출이 매달리는 것 방지 (body 수신까지 포함)
const TOKEN_SKEW_MS = 60000;          // 만료 60초 전 미리 재발급
const AUTH_DEAD_RETRY_MS = 30 * 60 * 1000; // invalid_grant(재승인 필요) 후 재시도 간격

class SdmClient {
  constructor(cfg, log) {
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.refreshToken = cfg.refreshToken;
    this.projectId = cfg.projectId;
    this.log = log || console;

    this._tok = null;
    this._exp = 0;
    this._refreshing = null;          // 동시 갱신 방지 (단일 in-flight promise 공유)

    // invalid_grant = refresh token 자체가 폐기됨(계정 비번 변경·보안 이벤트·수동 폐기).
    // 회복 불가 상태이므로 30분 간격으로만 재시도하고, 최초 1회 대문짝 안내를 남긴다.
    this.authDead = false;
    this._authDeadUntil = 0;
  }

  // fetch + body 수신까지 하나의 타임아웃으로 보호 (헤더만 오고 body가 스톨하는 케이스 방어)
  async _fetchText(url, opts = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      const body = await r.text();
      return { status: r.status, ok: r.ok, body };
    } finally {
      clearTimeout(t);
    }
  }

  async _accessToken() {
    if (this._tok && Date.now() < this._exp - TOKEN_SKEW_MS) return this._tok;
    if (this.authDead && Date.now() < this._authDeadUntil) {
      throw new Error('재승인 필요(invalid_grant) — 백오프 중, 30분 간격으로만 재시도');
    }
    if (!this._refreshing) {
      this._refreshing = (async () => {
        try {
          const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.refreshToken,
            grant_type: 'refresh_token',
          });
          const r = await this._fetchText(TOKEN_URL, { method: 'POST', body });
          if (!r.ok) {
            const txt = (r.body || '').slice(0, 200);
            if (r.status === 400 && /invalid_grant/i.test(txt)) {
              const first = !this.authDead;
              this.authDead = true;
              this._authDeadUntil = Date.now() + AUTH_DEAD_RETRY_MS;
              if (first) {
                this.log.error('[Nest KM81] ★ refresh token이 폐기되었습니다(invalid_grant) — 구글 재승인이 필요합니다. '
                  + 'PCM 승인(https://nestservices.google.com/partnerconnections/' + this.projectId + '/auth) 후 '
                  + 'config의 refreshToken을 교체하세요. 이후 30분 간격으로만 재시도합니다.');
              }
              const e = new Error('invalid_grant — 구글 재승인 필요');
              e.authDead = true;
              throw e;
            }
            throw new Error(`토큰 갱신 실패 HTTP ${r.status}: ${txt}`);
          }
          const j = JSON.parse(r.body);
          this._tok = j.access_token;
          this._exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
          if (this.authDead) {
            this.authDead = false;
            this.log.info('[Nest KM81] 토큰 갱신 회복됨 (재승인 상태 해제)');
          }
          return this._tok;
        } finally {
          this._refreshing = null;
        }
      })();
    }
    return this._refreshing;
  }

  async _call(path, opts = {}, _retried = false) {
    const tok = await this._accessToken();
    const r = await this._fetchText(`${SDM_BASE}/${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (r.status === 401) {
      this._tok = null; // 무효 토큰 폐기
      if (!_retried) return this._call(path, opts, true); // 재발급 후 1회만 즉시 재시도
      throw new Error('SDM 401 (재시도 후에도 인증 실패)');
    }
    if (!r.ok) {
      const txt = (r.body || '').slice(0, 300);
      const err = new Error(`SDM HTTP ${r.status}: ${txt}`);
      err.status = r.status;
      throw err;
    }
    return JSON.parse(r.body);
  }

  async listDevices() {
    const j = await this._call(`enterprises/${this.projectId}/devices`);
    return j.devices || [];
  }

  // name = 'enterprises/<pid>/devices/<did>' (SDM 리소스 경로 그대로)
  async getDevice(name) {
    return this._call(name);
  }

  async executeCommand(name, command, params) {
    return this._call(`${name}:executeCommand`, {
      method: 'POST',
      body: JSON.stringify({ command, params: params || {} }),
    });
  }
}

module.exports = SdmClient;
