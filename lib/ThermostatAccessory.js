'use strict';

/**
 * ThermostatAccessory — SDM THERMOSTAT → HomeKit Thermostat.
 *
 * 설계는 homebridge-xiaomi-km81 패턴을 따른다:
 *  - 낙관적 상태 캐시(state) + HomeKit getter는 캐시 즉답.
 *  - setTimeout 폴링 루프(setInterval 아님) + finally 재무장 → 루프가 죽지 않음.
 *  - 명령 grace: set 직후 낙관 UI 갱신 + stale 폴링값 무시(SDM은 반영이 느려 8초).
 *  - verify burst: set 후 짧은 간격 재폴링으로 실제 반영 확인.
 */

const DEFAULT_POLLING_MS = 30000;              // SDM 쿼터(분당 10회/유저) 고려 — 30초면 2 QPM
const MIN_POLLING_MS = 15000;
const COMMAND_GRACE_MS = 15000;                // 마지막 verify burst(12s)보다 길어야 UI 왕복이 없다 (v1.0.1: 8s→15s)
const VERIFY_BURST_DELAYS = [2500, 6000, 12000];
const UNREACHABLE_AFTER_FAILS = 3;             // 폴링 연속 실패 N회부터 홈킷에 '응답 없음' 표시
const SETPOINT_MIN_C = 9;                      // Nest 난방 설정 범위

// 로그 표기용 한글 이름 (v2.1.0 — 시인성/일관성)
const MODE_KO = { OFF: '꺼짐', HEAT: '난방', COOL: '냉방', HEATCOOL: '자동' };
const modeKo = (m) => MODE_KO[m] || m;
const ecoKo = (e) => (e && e !== 'OFF' ? '켜짐' : '꺼짐');
const SETPOINT_MAX_C = 32;

const T = {
  INFO: 'sdm.devices.traits.Info',
  CONNECTIVITY: 'sdm.devices.traits.Connectivity',
  HUMIDITY: 'sdm.devices.traits.Humidity',
  TEMPERATURE: 'sdm.devices.traits.Temperature',
  MODE: 'sdm.devices.traits.ThermostatMode',
  ECO: 'sdm.devices.traits.ThermostatEco',
  HVAC: 'sdm.devices.traits.ThermostatHvac',
  SETPOINT: 'sdm.devices.traits.ThermostatTemperatureSetpoint',
  SETTINGS: 'sdm.devices.traits.Settings',
};

class ThermostatAccessory {
  constructor({ platform, device }) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;
    this.sdm = platform.sdm;

    this.deviceName = device.name; // SDM 리소스 경로 'enterprises/.../devices/...'
    const traits = device.traits || {};
    const custom = (traits[T.INFO] || {}).customName;
    const parent = ((device.parentRelations || [])[0] || {}).displayName;
    this.name = platform.config.nameOverride || custom || parent || 'Nest 온도조절기';

    this.state = {};        // mode, hvac, ambientC, humidity, heatC, eco, units, online
    this.pending = {};      // key → { target, expire }
    this.pollTimer = null;
    this.burstTimers = [];
    this._shutdown = false;
    this._pollFailStreak = 0;

    this.UUID = this.hap.uuid.generate(`nest-km81:thermostat:${device.name}`);
    let accessory = this.platform.accessories.get(this.UUID);
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.name, this.UUID, this.hap.Categories.THERMOSTAT);
      this.api.registerPlatformAccessories(platform.PLUGIN_NAME, platform.PLATFORM_NAME, [accessory]);
      this.platform.accessories.set(this.UUID, accessory);
    }
    this.accessory = accessory;

    this.setupInformation();
    this.setupThermostatService();
    this.setupEcoSwitch();
    this.applyDevice(device);
    this.updateAll();
    this.schedulePolling();
    this.logInfo(`등록됨 (${this.deviceName.split('/').pop().slice(0, 8)}…, 폴링 ${this.pollIntervalMs() / 1000}s)`);
  }

  pollIntervalMs() {
    const s = Number(this.platform.config.pollingInterval);
    return Math.max(MIN_POLLING_MS, (Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_POLLING_MS));
  }

  /*============================ SERVICES ============================*/

  setupInformation() {
    const { Service, Characteristic } = this;
    let info = this.accessory.getService(Service.AccessoryInformation);
    if (!info) info = this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Google Nest')
      .setCharacteristic(Characteristic.Model, 'Nest Thermostat (SDM)')
      .setCharacteristic(Characteristic.SerialNumber, this.deviceName.split('/').pop().slice(0, 16))
      .setCharacteristic(Characteristic.FirmwareRevision, this.platform.packageVersion || '1.0.0');
  }

  setupThermostatService() {
    const { Service, Characteristic } = this;
    const svc = this.accessory.getService(Service.Thermostat)
      || this.accessory.addService(Service.Thermostat, this.name);
    this.svc = svc;

    svc.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: SETPOINT_MIN_C, maxValue: SETPOINT_MAX_C, minStep: 0.5 })
      .onSet(async (v) => {
        const target = Math.round(Number(v) * 2) / 2;
        const prevHeat = this.state.heatC;
        const prevEco = this.state.eco;
        const prevMode = this.state.mode;
        // 낙관 갱신: heatC와 함께 eco/mode도 목표 상태로 — updateAll의 eco 분기가
        // 낙관값을 가려 UI가 에코 온도로 스냅백하는 것 방지 (v1.0.1)
        this.beginGrace('heatC', target);
        this.state.heatC = target;
        const needEcoOff = !!(prevEco && prevEco !== 'OFF');
        const needModeOn = (prevMode === 'OFF');
        if (needEcoOff) { this.beginGrace('eco', 'OFF'); this.state.eco = 'OFF'; }
        if (needModeOn) { this.beginGrace('mode', 'HEAT'); this.state.mode = 'HEAT'; }
        this.updateAll();
        let ecoDisabled = false;
        let modeTurnedOn = false;
        try {
          // 에코 모드 중에는 SDM이 설정온도 변경을 거부 → 에코 먼저 해제
          if (needEcoOff) {
            this.logInfo('에코 모드 해제 후 온도 설정');
            await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatEco.SetMode', { mode: 'OFF' });
            ecoDisabled = true;
          }
          // OFF 모드에서는 설정온도 변경이 거부됨 → 씬("난방 22도")이 모드·온도를 동시 발사해도
          // 동작하도록 HEAT 선행 전환 (v1.0.1)
          if (needModeOn) {
            this.logInfo('OFF 모드 → HEAT 전환 후 온도 설정');
            await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: 'HEAT' });
            modeTurnedOn = true;
          }
          await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat', { heatCelsius: target });
          this.logInfo(`설정온도 → ${target}°C`);
        } catch (e) {
          // 롤백 (부분 성공 보상 포함). v2.1.1 — 자기가 시작한 체인의 grace만 정리
          // (무조건 endGrace하면 병행 중인 다른 setter의 낙관 상태를 지워버림 — 적대 리뷰 MED)
          this.endGrace('heatC'); this.state.heatC = prevHeat;
          if (needModeOn) {
            if (!modeTurnedOn) {
              this.endGrace('mode'); this.state.mode = prevMode;
            } else {
              // v2.1.1 — HEAT 전환은 이미 기기에 반영됨: 로컬만 되돌리면 보일러가 켜진 채
              // 남는 물리 반쪽 상태(적대 리뷰 HIGH) → 베스트에포트로 기기 모드도 되돌린다.
              try {
                await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: prevMode });
                this.endGrace('mode'); this.state.mode = prevMode;
                this.logWarn('온도 설정 실패 → 모드를 되돌렸습니다 (꺼짐)');
              } catch (_) {
                this.endGrace('mode'); this.state.mode = 'HEAT';
                this.logWarn('★온도 설정 실패 + 모드 복원도 실패 — 난방이 켜진 상태로 남았습니다 (직전 설정온도로 동작 중)');
              }
            }
          }
          if (needEcoOff) {
            if (!ecoDisabled) {
              this.endGrace('eco'); this.state.eco = prevEco;
            } else {
              // 에코는 이미 해제됨 — 베스트에포트 복원 (실패 시 해제 상태로 남음을 명시)
              try {
                await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatEco.SetMode', { mode: prevEco });
                this.endGrace('eco'); this.state.eco = prevEco;
                this.logWarn('온도 설정 실패 → 에코 모드를 복원했습니다');
              } catch (_) {
                this.endGrace('eco'); this.state.eco = 'OFF';
                this.logWarn('온도 설정 실패 + 에코 복원도 실패 — 에코가 해제된 상태로 남았습니다');
              }
            }
          }
          this.updateAll();
          this.logWarn(`설정온도 변경 실패: ${e.message || e}`);
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    const modeChar = svc.getCharacteristic(Characteristic.TargetHeatingCoolingState);
    modeChar.onSet(async (v) => {
      const map = {
        [Characteristic.TargetHeatingCoolingState.OFF]: 'OFF',
        [Characteristic.TargetHeatingCoolingState.HEAT]: 'HEAT',
        [Characteristic.TargetHeatingCoolingState.COOL]: 'COOL',
        [Characteristic.TargetHeatingCoolingState.AUTO]: 'HEATCOOL',
      };
      const next = map[v] || 'HEAT';
      const prev = this.state.mode;
      this.beginGrace('mode', next);
      this.state.mode = next;
      this.updateAll();
      try {
        await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: next });
        this.logInfo(`모드 → ${modeKo(next)}`);
      } catch (e) {
        this.endGrace('mode');
        this.state.mode = prev;
        this.updateAll();
        this.logWarn(`모드 변경 실패: ${e.message || e}`);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  // 에코 토글 (v1.1.1) — 별도 액세서리가 아니라 보일러 액세서리 안의 서비스
  // (에어컨 스윙처럼 홈 앱 타일 1개, 상세 화면에 토글로 표시).
  setupEcoSwitch() {
    const { Service, Characteristic } = this;
    if (this.platform.config.showEcoSwitch === false) {
      const old = this.accessory.getServiceById(Service.Switch, 'eco');
      if (old) this.accessory.removeService(old);
      this.ecoSvc = null;
      return;
    }
    const svc = this.accessory.getServiceById(Service.Switch, 'eco')
      || this.accessory.addService(Service.Switch, '에코', 'eco');
    try { this.svc.setPrimaryService(true); } catch (_) { /* 타일 아이콘 = 온도조절기 유지 */ }
    svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
      const prev = this.state.eco;
      const next = on ? 'MANUAL_ECO' : 'OFF';
      if ((prev && prev !== 'OFF') === !!on) return; // 이미 같은 상태
      this.beginGrace('eco', next);
      this.state.eco = next;
      this.updateAll();
      let modeTurnedOn = false;
      const prevMode = this.state.mode;
      try {
        // 에코는 난방 꺼짐(OFF) 상태에선 켤 수 없음 → HEAT 선행 (온도 설정과 동일 패턴)
        if (on && this.state.mode === 'OFF') {
          this.logInfo('OFF 모드 → HEAT 전환 후 에코 설정');
          this.beginGrace('mode', 'HEAT');
          await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: 'HEAT' });
          this.state.mode = 'HEAT';
          modeTurnedOn = true;
        }
        await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatEco.SetMode', { mode: next });
        this.logInfo(`에코 → ${on ? '켜짐' : '꺼짐'}`);
      } catch (e) {
        this.endGrace('eco');
        this.state.eco = prev;
        // v2.1.1 — HEAT 선행이 이미 기기에 반영된 뒤 에코 설정이 실패하면 보일러가 켜진 채
        // 남는 물리 반쪽 상태 → 베스트에포트로 모드 복원 (+누락돼 있던 mode grace 정리)
        if (modeTurnedOn) {
          try {
            await this.sdm.executeCommand(this.deviceName, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: prevMode });
            this.endGrace('mode'); this.state.mode = prevMode;
            this.logWarn('에코 설정 실패 → 모드를 되돌렸습니다 (꺼짐)');
          } catch (_) {
            this.endGrace('mode'); this.state.mode = 'HEAT';
            this.logWarn('★에코 설정 실패 + 모드 복원도 실패 — 난방이 켜진 상태로 남았습니다');
          }
        }
        this.updateAll();
        this.logWarn(`에코 전환 실패: ${e.message || e}`);
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
    this.ecoSvc = svc;
  }

  /*============================ STATE ============================*/

  applyDevice(d) {
    const tr = d.traits || {};
    if (tr[T.MODE]) {
      this.state.mode = tr[T.MODE].mode;
      // v2.1.1 — 이벤트의 부분 MODE trait에 availableModes가 없으면 실측값 유지 (기본값으로 덮지 않음)
      this.state.availableModes = tr[T.MODE].availableModes || this.state.availableModes || ['HEAT', 'OFF'];
    }
    if (tr[T.HVAC]) this.state.hvac = tr[T.HVAC].status;                     // HEATING | COOLING | OFF
    if (tr[T.TEMPERATURE]) this.state.ambientC = tr[T.TEMPERATURE].ambientTemperatureCelsius;
    if (tr[T.HUMIDITY]) this.state.humidity = tr[T.HUMIDITY].ambientHumidityPercent;
    if (tr[T.ECO]) {
      this.state.eco = tr[T.ECO].mode;                                       // MANUAL_ECO | OFF
      this.state.ecoHeatC = tr[T.ECO].heatCelsius;
    }
    if (tr[T.SETPOINT] && tr[T.SETPOINT].heatCelsius !== undefined) {
      this.state.heatC = tr[T.SETPOINT].heatCelsius;
    }
    if (tr[T.SETTINGS]) this.state.units = tr[T.SETTINGS].temperatureScale;  // CELSIUS | FAHRENHEIT
    if (tr[T.CONNECTIVITY]) this.state.online = tr[T.CONNECTIVITY].status === 'ONLINE';
    this.applyGrace();
  }

  applyGrace() {
    const now = Date.now();
    for (const key of Object.keys(this.pending)) {
      const p = this.pending[key];
      if (!p) continue;
      if (now >= p.expire) { this.endGrace(key); continue; }
      // v2.1.1 — heatC는 SDM이 21.98993… 식 잔여 소수를 주므로 0.5 스냅 후 비교해야
      // "목표 확인 → 즉시 해제"가 실제로 성립한다 (기존엔 등호 불성립으로 burst 3회 항상 소진)
      const cur = (key === 'heatC' && Number.isFinite(this.state[key]))
        ? Math.round(this.state[key] * 2) / 2 : this.state[key];
      if (cur === p.target) this.endGrace(key);               // 폴링이 목표 확인 → 즉시 해제
      else this.state[key] = p.target;                        // stale 값 → 목표로 덮음 (UI 안정)
    }
  }

  beginGrace(key, target) {
    this.pending[key] = { target, expire: Date.now() + COMMAND_GRACE_MS };
    this.scheduleVerifyBurst();
  }

  endGrace(key) {
    delete this.pending[key];
    if (Object.keys(this.pending).length === 0) this.clearBurstTimers();
  }

  scheduleVerifyBurst() {
    if (this._shutdown) return;   // v2.1.1 — 셧다운 후 진행 중이던 onSet이 새 타이머를 심는 것 방지
    this.clearBurstTimers();
    VERIFY_BURST_DELAYS.forEach((d) => {
      const t = setTimeout(() => {
        if (Object.keys(this.pending).length > 0) {
          this.refresh().catch(() => { /* burst 실패는 다음 정규 폴링으로 회복 */ });
        }
      }, d);
      this.burstTimers.push(t);
    });
  }

  clearBurstTimers() {
    this.burstTimers.forEach((t) => clearTimeout(t));
    this.burstTimers = [];
  }

  /*============================ POLLING ============================*/

  schedulePolling() {
    const iv = this.pollIntervalMs();
    const loop = async () => {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      try {
        await this.refresh();
        if (this._pollFailStreak >= UNREACHABLE_AFTER_FAILS) this.logInfo(`폴링 회복됨 (${this._pollFailStreak}회 실패 후 정상화)`);
        this._pollFailStreak = 0;
      } catch (e) {
        this._pollFailStreak++;
        // 연속 실패 3회부터, 이후 10회마다 한 번만 경고 (로그 홍수 방지)
        if (this._pollFailStreak === UNREACHABLE_AFTER_FAILS || this._pollFailStreak % 10 === 0) {
          this.logWarn(`폴링 실패 x${this._pollFailStreak}: ${e.message || e}`);
        }
        // stale 값을 살아있는 값처럼 계속 노출하지 않기 — 홈킷에 '응답 없음' 표시 (v1.0.1)
        if (this._pollFailStreak >= UNREACHABLE_AFTER_FAILS) this.markUnreachable();
      } finally {
        if (!this._shutdown) this.pollTimer = setTimeout(loop, iv);
      }
    };
    this.pollTimer = setTimeout(loop, iv);
  }

  async refresh() {
    const t0 = Date.now();
    const d = await this.sdm.getDevice(this.deviceName);
    // v2.1.1 — GET 진행 중 더 새로운 Pub/Sub 이벤트가 반영됐으면 이 응답은 stale → 폐기
    // (낡은 폴링/burst 응답이 이벤트 새 값을 최대 30초 되돌리던 표시 회귀 차단. 다음 폴이 곧 재확인)
    if (this._lastEventTs && this._lastEventTs > t0) return;
    this.applyDevice(d);
    // 기기 자체가 오프라인(CONNECTIVITY=OFFLINE)이면 traits는 stale — '응답 없음'으로 표시 (v1.0.1)
    if (this.state.online === false) {
      this._noteOffline();
      this.markUnreachable();
      return;
    }
    this._noteOnline();
    this.updateAll();
  }

  // 오프라인 진입/복귀 전이 로그 — 전이 시 1회만 (v2.0.0)
  _noteOffline() {
    if (this._offlineLogged) return;
    this._offlineLogged = true;
    this.logWarn("기기 오프라인(CONNECTIVITY) — 홈킷에 '응답 없음' 표시");
  }

  _noteOnline() {
    if (!this._offlineLogged) return;
    this._offlineLogged = false;
    this.logInfo("기기 온라인 복귀 — '응답 없음' 해제");
  }

  // Pub/Sub 이벤트 수신 (v1.1.0) — resourceUpdate.traits 부분 패치를 상태에 머지.
  // applyDevice가 존재하는 trait만 갱신(부분 안전)하고 applyGrace가 명령 보호 구간을 지킨다.
  // 이벤트는 at-least-once(중복 가능)지만 머지가 멱등이라 무해.
  handleEvent(traits) {
    try {
      this._lastEventTs = Date.now();   // v2.1.1 — refresh()의 stale 응답 폐기 기준
      const before = { heatC: this.state.heatC, mode: this.state.mode, eco: this.state.eco };
      this.applyDevice({ traits });
      if (this.state.online === false) { this._noteOffline(); this.markUnreachable(); return; }
      this._noteOnline();
      this.updateAll();
      // 의미 있는 변화만 로그 (온도·습도 미세 변동은 침묵 — 로그 홍수 방지)
      if (before.heatC !== this.state.heatC && traits[T.SETPOINT]) this.logInfo(`이벤트: 설정온도 → ${(Math.round(this.state.heatC * 2) / 2).toFixed(1)}°C`);
      if (before.mode !== this.state.mode && traits[T.MODE]) this.logInfo(`이벤트: 모드 → ${modeKo(this.state.mode)}`);
      if (before.eco !== this.state.eco && traits[T.ECO]) this.logInfo(`이벤트: 에코 → ${ecoKo(this.state.eco)}`);
    } catch (e) {
      this.logWarn(`이벤트 처리 실패(폴링이 보정): ${e.message || e}`);
    }
  }

  // 홈킷 '응답 없음' 표시 — CurrentTemperature 읽기에 통신 오류를 태운다.
  // 회복 시 updateAll()이 실값을 다시 push하면 자동 해제된다.
  markUnreachable() {
    if (!this.svc) return;
    try {
      this.svc.updateCharacteristic(this.Characteristic.CurrentTemperature,
        new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    } catch (_) { /* HAP 버전별 방어 */ }
  }

  /*============================ HOMEKIT PUSH ============================*/

  updateAll() {
    const { Characteristic } = this;
    const s = this.state;
    const svc = this.svc;
    if (!svc) return;

    if (Number.isFinite(s.ambientC)) {
      svc.updateCharacteristic(Characteristic.CurrentTemperature, s.ambientC);
    }
    // 에코 모드 중엔 에코 setpoint가 실효값. Nest가 21.95633 같은 잔여 소수를 주므로 0.5 스냅.
    const heat = (s.eco && s.eco !== 'OFF' && Number.isFinite(s.ecoHeatC)) ? s.ecoHeatC : s.heatC;
    if (Number.isFinite(heat)) {
      const snapped = Math.round(heat * 2) / 2;
      svc.updateCharacteristic(Characteristic.TargetTemperature,
        Math.min(SETPOINT_MAX_C, Math.max(SETPOINT_MIN_C, snapped)));
    }
    if (Number.isFinite(s.humidity)) {
      svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, s.humidity);
    }

    const tMap = { OFF: 0, HEAT: 1, COOL: 2, HEATCOOL: 3 };
    if (s.mode in tMap) {
      svc.updateCharacteristic(Characteristic.TargetHeatingCoolingState, tMap[s.mode]);
    }
    const cMap = { OFF: 0, HEATING: 1, COOLING: 2 };
    if (s.hvac in cMap) {
      svc.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, cMap[s.hvac]);
    }
    if (s.units) {
      svc.updateCharacteristic(Characteristic.TemperatureDisplayUnits,
        s.units === 'FAHRENHEIT' ? 1 : 0);
    }
    if (this.ecoSvc) {
      this.ecoSvc.updateCharacteristic(Characteristic.On, !!(s.eco && s.eco !== 'OFF'));
    }
    // 지원 모드만 선택지로 노출 (예: 보일러 = OFF/HEAT만)
    if (Array.isArray(s.availableModes) && !this._validValuesSet) {
      const valid = s.availableModes.map((m) => tMap[m]).filter((v) => v !== undefined).sort();
      if (valid.length) {
        this.svc.getCharacteristic(Characteristic.TargetHeatingCoolingState)
          .setProps({ validValues: valid });
        this._validValuesSet = true;
      }
    }
  }

  shutdown() {
    this._shutdown = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.clearBurstTimers();
  }

  logInfo(m) { this.log.info(`[${this.name}] ${m}`); }
  logWarn(m) { this.log.warn(`[${this.name}] ${m}`); }
}

module.exports = ThermostatAccessory;
