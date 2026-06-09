import { deriveRangeSide, OOR_RANGE_SIDES } from "./oor-reposition.js";

export function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function normalizeRangeSide(value) {
  if (
    value === OOR_RANGE_SIDES.IN ||
    value === OOR_RANGE_SIDES.ABOVE ||
    value === OOR_RANGE_SIDES.BELOW
  ) {
    return value;
  }
  return null;
}

function isLiveBinSource(source) {
  return source === "live_bin_data" || source === "live_position_data";
}

export function buildEffectiveRangeState({
  source_in_range = null,
  in_range = null,
  active_bin = null,
  lower_bin = null,
  upper_bin = null,
  active_bin_source = null,
  lower_bin_source = null,
  upper_bin_source = null,
  range_side = null,
  range_state_source = null,
} = {}) {
  const sourceInRange = typeof source_in_range === "boolean"
    ? source_in_range
    : typeof in_range === "boolean"
      ? in_range
      : null;
  const lowerBin = finiteNumberOrNull(lower_bin);
  const upperBin = finiteNumberOrNull(upper_bin);
  const activeBin = finiteNumberOrNull(active_bin);
  const candidateRangeSide = normalizeRangeSide(range_side) ?? normalizeRangeSide(deriveRangeSide({
    active_bin: activeBin,
    lower_bin: lowerBin,
    upper_bin: upperBin,
  }));
  const liveBinsAvailable = isLiveBinSource(active_bin_source) &&
    isLiveBinSource(lower_bin_source) &&
    isLiveBinSource(upper_bin_source);
  const derivedRangeSide = liveBinsAvailable ? candidateRangeSide : OOR_RANGE_SIDES.UNKNOWN;
  const derivedInRange = derivedRangeSide === OOR_RANGE_SIDES.UNKNOWN ? null : derivedRangeSide === OOR_RANGE_SIDES.IN;
  const effectiveInRange = derivedInRange ?? sourceInRange;
  const mismatch = sourceInRange != null && derivedInRange != null
    ? sourceInRange !== derivedInRange
    : false;
  const source = derivedInRange != null
    ? "derived_live_bins"
    : sourceInRange != null
      ? "api_source"
      : range_state_source ?? "unknown";

  return {
    source_in_range: sourceInRange,
    derived_range_side: derivedRangeSide,
    derived_in_range: derivedInRange,
    effective_in_range: effectiveInRange,
    range_state_mismatch: mismatch,
    range_state_source: source,
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: activeBin,
    lower_bin_source: lower_bin_source ?? null,
    upper_bin_source: upper_bin_source ?? null,
    active_bin_source: active_bin_source ?? null,
  };
}

export function buildEffectiveRangeStateFromPosition(position = {}) {
  return buildEffectiveRangeState({
    source_in_range: position.source_in_range,
    in_range: position.in_range,
    active_bin: position.active_bin ?? position.bin_range?.active,
    lower_bin: position.lower_bin ?? position.min_bin ?? position.bin_range?.min,
    upper_bin: position.upper_bin ?? position.max_bin ?? position.bin_range?.max,
    active_bin_source: position.active_bin_source,
    lower_bin_source: position.lower_bin_source,
    upper_bin_source: position.upper_bin_source,
    range_side: position.range_side ?? position.derivedRangeSide ?? position.derived_range_side,
    range_state_source: position.range_state_source,
  });
}
