// ============================================================================
// ペアリング (P2 §A-2 / M7)。
// デスクトップに PIN を表示 → スマホが PIN を送信 → デバイスごとに長期トークン発行。
// 以降はトークンで自動接続。デスクトップからデバイス失効が可能。
// ============================================================================

import { randomBytes, randomInt } from 'node:crypto';
import type { Device } from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { Store } from '../store/store.js';

const PIN_TTL_MS = 10 * 60 * 1000;
const PIN_KEY = 'pair:pin';
const PIN_EXP_KEY = 'pair:pin_expires';

export class PairingManager {
  constructor(private readonly store: Store) {}

  /** 新しい PIN を発行（10 分有効）。デスクトップの QR に添える。 */
  generatePin(): { pin: string; expiresAt: number } {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = now() + PIN_TTL_MS;
    this.store.setSetting(PIN_KEY, pin);
    this.store.setSetting(PIN_EXP_KEY, String(expiresAt));
    return { pin, expiresAt };
  }

  currentPin(): { pin: string; expiresAt: number } | null {
    const pin = this.store.getSetting(PIN_KEY);
    const exp = Number(this.store.getSetting(PIN_EXP_KEY) ?? 0);
    if (!pin || exp < now()) return null;
    return { pin, expiresAt: exp };
  }

  private verifyPin(pin: string): boolean {
    const cur = this.currentPin();
    return !!cur && cur.pin === pin;
  }

  /** PIN 検証に成功したらデバイストークンを発行する。 */
  pair(pin: string, deviceName: string): { token: string; deviceId: string } | null {
    if (!this.verifyPin(pin)) return null;
    const token = randomBytes(32).toString('hex');
    const device: Device = {
      id: newId('dev'),
      name: deviceName || 'デバイス',
      token,
      createdAt: now(),
      lastSeen: now(),
      revoked: false,
    };
    this.store.addDevice(device);
    // 使い切り: ペアリング後は PIN を失効させる。
    this.store.setSetting(PIN_EXP_KEY, '0');
    return { token, deviceId: device.id };
  }

  /** トークン検証。有効なら lastSeen を更新して Device を返す。 */
  authenticate(token: string | undefined): Device | null {
    if (!token) return null;
    const device = this.store.getDeviceByToken(token);
    if (!device) return null;
    this.store.touchDevice(device.id, now());
    return device;
  }

  listDevices(): Device[] {
    return this.store.listDevices();
  }
  revoke(deviceId: string): void {
    this.store.revokeDevice(deviceId);
  }
}
