/**
 * signal-tracker.js — Stages screening signals for later attribution.
 *
 * Signals are written through to staged-signals.json so they survive a
 * process restart between screen and deploy (the typical run-once-per-tick
 * schedule means screening and deploying happen in separate invocations).
 *
 * Disk format: { "<poolAddress>": { ...signals, staged_at: <epochMs> }, … }
 * Entries older than STAGE_TTL_MS are skipped on load and never saved back.
 */

import fs from "fs";
import { log } from "./logger.js";

const STAGE_FILE = "./staged-signals.json";

// In-memory staging area — primary look-up; disk is the persistence layer
const _staged = new Map();
const _stagedByBaseMint = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(value) {
  return value ? String(value).trim() : null;
}

// ─── Disk helpers ────────────────────────────────────────────────────────────

function _loadFromDisk() {
  if (!fs.existsSync(STAGE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STAGE_FILE, "utf8"));
    const now = Date.now();
    for (const [poolKey, entry] of Object.entries(raw || {})) {
      // Skip stale entries on load — no point hydrating something we'd TTL out
      if (now - (entry.staged_at || 0) > STAGE_TTL_MS) continue;
      if (!_staged.has(poolKey)) {
        _staged.set(poolKey, entry);
        const bm = normalizeKey(entry.base_mint);
        if (bm) _stagedByBaseMint.set(bm, poolKey);
      }
    }
  } catch (err) {
    log("signal_tracker_warn", `Could not load ${STAGE_FILE}: ${err.message}`);
  }
}

function _saveToDisk() {
  const data = {};
  for (const [poolKey, entry] of _staged) {
    data[poolKey] = entry;
  }
  try {
    fs.writeFileSync(STAGE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("signal_tracker_warn", `Could not save ${STAGE_FILE}: ${err.message}`);
  }
}

// Hydrate from disk once at module load — handles the restart-between-ticks case
_loadFromDisk();

// ─── TTL cleanup ─────────────────────────────────────────────────────────────

function cleanupStale() {
  const now = Date.now();
  let changed = false;
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
      changed = true;
    }
  }
  return changed;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param {string} poolAddress
 * @param {object} signals — { organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, hive_consensus, volatility }
 */
export function stageSignals(poolAddress, signals) {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;

  const baseMint = normalizeKey(signals?.base_mint || signals?.baseMint);
  _staged.set(poolKey, {
    ...signals,
    base_mint: baseMint || signals?.base_mint || null,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _stagedByBaseMint.set(baseMint, poolKey);
  }

  _saveToDisk();
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(poolAddress, baseMint = null) {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : null;
    data = poolKey ? _staged.get(poolKey) : null;
  }

  if (!data) return null;
  _staged.delete(poolKey);
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }

  _saveToDisk();

  const { staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolKey.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools() {
  cleanupStale();
  return [..._staged.keys()];
}
