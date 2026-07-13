'use strict';

const SdmClient = require('./lib/SdmClient.js');
const ThermostatAccessory = require('./lib/ThermostatAccessory.js');
const PubSubListener = require('./lib/PubSubListener.js');

const PLUGIN_NAME = 'homebridge-nest-km81';
const PLATFORM_NAME = 'NestKm81';
const DISCOVER_RETRY_MAX_DELAY_MS = 5 * 60 * 1000; // 검색 재시도 백오프 상한 (v1.0.1: 무한 재시도)

class NestKm81Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.PLUGIN_NAME = PLUGIN_NAME;
    this.PLATFORM_NAME = PLATFORM_NAME;
    this.accessories = new Map();   // UUID → cached PlatformAccessory
    this.handlers = [];
    try {
      this.packageVersion = require('./package.json').version;
    } catch (_) { this.packageVersion = '0.0.0'; }

    if (!api) return;

    const missing = ['clientId', 'clientSecret', 'refreshToken', 'projectId']
      .filter((k) => !this.config[k]);
    if (missing.length) {
      this.log.error(`설정 누락: ${missing.join(', ')} — 플랫폼을 시작하지 않습니다. (config.schema 참조)`);
      return;
    }

    this.sdm = new SdmClient(this.config, this.log);

    api.on('didFinishLaunching', () => {
      this._discoverLoop();
    });
    api.on('shutdown', () => {
      this._shutdown = true;
      if (this.pubsub) this.pubsub.stop();
      this.handlers.forEach((h) => h.shutdown());
    });
  }

  // Pub/Sub 실시간 이벤트 (v1.1.0) — 검색 성공 후 시작. 실패해도 폴링만으로 동작(치명 아님).
  _startPubSub() {
    if (this.pubsub) return;
    if (this.config.enablePubSub === false) return;
    const cloudProjectId = this.config.cloudProjectId;
    if (!cloudProjectId) {
      this.log.info('cloudProjectId 미설정 — Pub/Sub 실시간 이벤트 없이 폴링으로만 동작합니다.');
      return;
    }
    this.pubsub = new PubSubListener({
      sdm: this.sdm,
      cloudProjectId,
      subscription: this.config.pubsubSubscription || 'homebridge-nest-km81-sub',
      log: this.log,
      onEvent: (data) => this._onSdmEvent(data),
    });
    this.pubsub.start();
  }

  _onSdmEvent(data) {
    const ru = data && data.resourceUpdate;
    if (!ru || !ru.name || !ru.traits) return; // relationUpdate 등은 무시
    for (const h of this.handlers) {
      if (h.deviceName === ru.name) { h.handleEvent(ru.traits); return; }
    }
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  // v1.0.1: 검색 실패 시 영구 포기하지 않는다 — NAS/공유기 재부팅 직후 Homebridge가
  // 인터넷보다 먼저 뜨는 상황에서 캐시 액세서리가 좀비(표시만 되고 무반응)로 남는 것 방지.
  async _discoverLoop() {
    let attempt = 0;
    while (!this._shutdown) {
      try {
        await this.discover();
        return;
      } catch (e) {
        attempt++;
        const delay = Math.min(attempt * 5000, DISCOVER_RETRY_MAX_DELAY_MS);
        this.log.warn(`기기 검색 실패 (${attempt}회): ${e.message || e} — ${Math.round(delay / 1000)}초 후 재시도`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async discover() {
    const devices = await this.sdm.listDevices();

    const thermostats = (devices || []).filter((d) => d.type === 'sdm.devices.types.THERMOSTAT');
    if (!thermostats.length) {
      this.log.warn('THERMOSTAT 기기를 찾지 못했습니다. (Device Access 권한/승인 확인)');
    }

    const seen = new Set();
    for (const d of thermostats) {
      // UUID를 생성 시도 전에 seen에 등록 — 생성자가 등록 후 중간에 실패해도
      // 아래 stale 정리가 방금 등록된 액세서리를 지우지 않게 (v1.0.1)
      // (문자열 포맷은 ThermostatAccessory 생성자와 반드시 일치 유지)
      seen.add(this.api.hap.uuid.generate(`nest-km81:thermostat:${d.name}`));
      try {
        const h = new ThermostatAccessory({ platform: this, device: d });
        this.handlers.push(h);
      } catch (e) {
        this.log.error(`온도조절기 등록 실패 (${d.name}): ${e.message || e}`);
      }
    }

    if (this.handlers.length) this._startPubSub();

    // 사라진(또는 등록 실패한 적 없는 stale) 캐시 액세서리 정리 — 단, 이번 검색이
    // 성공했고 실제 기기가 1개 이상 잡혔을 때만 (일시 오류로 기기를 지우는 것 방지)
    if (thermostats.length > 0) {
      for (const [uuid, acc] of this.accessories) {
        if (!seen.has(uuid)) {
          this.log.info(`stale 액세서리 제거: ${acc.displayName}`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
          this.accessories.delete(uuid);
        }
      }
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, NestKm81Platform);
};
