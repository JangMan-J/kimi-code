/**
 * Local device signals for a first region judgment of a logged-out client,
 * made on device with no network call, plus the detection rule.
 *
 * The signals are user-preference hints, not location proof: the IANA time
 * zone name is the strongest of them (Asia/Shanghai is essentially only set
 * by mainland-China users), the locale is weaker (an English locale is common
 * among mainland developers). The rule is therefore asymmetric: a 'global'
 * verdict requires a non-CN time zone with no contradicting locale, while
 * missing or conflicting signals fall back to 'mainland-cn' — the direction
 * that never exports a mainland user's data by mistake.
 *
 * Only the verdict ever leaves the device (as telemetry context metadata);
 * the raw signal values stay local (data minimization).
 */

import type { KimiRegion } from './region';

export interface LocalRegionSignals {
  readonly timeZone?: string;
  readonly locale?: string;
}

export interface LocalRegionDetection {
  readonly region: KimiRegion;
  /** False when signals were missing or conflicting and `region` is the fallback. */
  readonly confident: boolean;
}

/**
 * Reads the two signals every Node runtime exposes synchronously with no
 * extra permissions. Kept separate from the detection rule so tests inject
 * signals directly.
 */
export function collectLocalRegionSignals(): LocalRegionSignals {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    return { timeZone: resolved.timeZone, locale: resolved.locale };
  } catch {
    return {};
  }
}

/** Mainland time zones; Asia/Urumqi is used by some Xinjiang users. */
const CN_TIME_ZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi']);

/**
 * Zone names that carry no region information — the typical factory defaults
 * of servers and containers. They abstain instead of voting non-CN.
 */
const UNINFORMATIVE_TIME_ZONES = new Set([
  'UTC',
  'Etc/UTC',
  'Etc/Universal',
  'Etc/Zulu',
  'Universal',
  'Zulu',
  'GMT',
  'Etc/GMT',
  'Etc/GMT0',
  'Etc/GMT+0',
  'Etc/GMT-0',
  'GMT0',
  'GMT+0',
  'GMT-0',
  'Greenwich',
  'Etc/Greenwich',
  'Etc/Unknown',
  'Factory',
  'Etc/Factory',
]);

/**
 * Non-geographic zone spellings that still reach the OS: fixed-offset Etc
 * zones (Etc/GMT-8 — note the inverted sign — means UTC+8), bare numeric
 * offsets (+08:00), and POSIX letter-offset forms (CST-8). All abstain: an
 * offset alone says nothing about which side of the region line a user is on.
 */
const UNINFORMATIVE_TIME_ZONE_PATTERNS = [
  /^Etc\/GMT[+-]\d{1,2}$/,
  /^[+-]\d{2}:?\d{2}$/,
  /^[A-Za-z]{2,5}[+-]\d{1,2}(?::\d{2})?$/,
];

type SignalVote = 'cn' | 'non-cn' | 'none';

function timeZoneVote(timeZone: string | undefined): SignalVote {
  if (timeZone === undefined || timeZone.length === 0) return 'none';
  if (CN_TIME_ZONES.has(timeZone)) return 'cn';
  if (UNINFORMATIVE_TIME_ZONES.has(timeZone)) return 'none';
  if (UNINFORMATIVE_TIME_ZONE_PATTERNS.some((pattern) => pattern.test(timeZone))) {
    return 'none';
  }
  // Every other IANA zone — including Asia/Hong_Kong, Asia/Macau and
  // Asia/Taipei, which follow the international side under the current
  // compliance reading — votes non-CN.
  return 'non-cn';
}

function localeVote(locale: string | undefined): SignalVote {
  if (locale === undefined || locale.length === 0) return 'none';
  const lower = locale.toLowerCase();
  if (
    lower === 'zh' ||
    lower.startsWith('zh-hans') ||
    lower === 'zh-cn' ||
    lower.startsWith('zh-cn-')
  ) {
    return 'cn';
  }
  // zh-Hant* / zh-TW / zh-HK / zh-MO and every non-Chinese locale vote non-CN.
  return 'non-cn';
}

export function detectKimiRegionFromLocalSignals(
  signals: LocalRegionSignals,
): LocalRegionDetection {
  const timeZone = timeZoneVote(signals.timeZone);
  const locale = localeVote(signals.locale);
  if (timeZone === 'non-cn' && locale !== 'cn') return { region: 'global', confident: true };
  if (timeZone === 'cn' && locale !== 'non-cn') {
    return { region: 'mainland-cn', confident: true };
  }
  if (timeZone === 'none' && locale === 'cn') {
    return { region: 'mainland-cn', confident: true };
  }
  // Reaching here: conflicting votes, a lone non-CN locale (too weak on its
  // own), or no usable signal at all — fall back to mainland-cn.
  return { region: 'mainland-cn', confident: false };
}
