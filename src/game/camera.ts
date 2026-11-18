/**
 * Camera pose for FrameView (contracts.ts CameraView). The renderer places the actual camera and may pull it in to
 * avoid clipping; ClientGame only decides what to look at and from which angle.
 */
import type { CameraView } from '../shared/contracts';
import { DEG2RAD, wrapAngle } from '../shared/math';
import type { MapData, Vec3 } from '../shared/types';
import type { ClientTuning } from './tuning';

/** Over-the-shoulder follow: pivot at the feet + eyeHeight, looking along yaw/pitch. */
export function followCamera(feet: Vec3, yaw: number, pitch: number, eyeHeight: number, tuning: ClientTuning): CameraView {
  return {
    mode: 'follow',
    target: { x: feet.x, y: feet.y + eyeHeight, z: feet.z },
    yaw,
    pitch,
    distance: tuning.cameraDistance,
    shoulderOffset: tuning.cameraShoulderOffset,
    fovDeg: tuning.cameraFovDeg,
  };
}

/** Slow attract orbit around the island centre (title, lobby, countdown, nothing to spectate). */
export function orbitCamera(map: MapData, timeSeconds: number, tuning: ClientTuning): CameraView {
  return {
    mode: 'orbit',
    target: { x: 0, y: map.baseHeight, z: 0 },
    yaw: wrapAngle(timeSeconds * tuning.orbitDegPerSecond * DEG2RAD),
    pitch: tuning.orbitPitchDeg * DEG2RAD,
    distance: map.islandRadius * tuning.orbitDistanceFactor,
    shoulderOffset: 0,
    fovDeg: tuning.cameraFovDeg,
  };
}
