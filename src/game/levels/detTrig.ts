/**
 * Deterministic trig for arbitrary angles (review MF2). The implementation moved to src/shared/detmath.ts (tech-lead);
 * this module re-exports it so level data imports stay unchanged.
 */
export { sinRad, cosRad, atanDet, atan2Det, hypot2 } from '../../shared/detmath';
