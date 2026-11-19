/**
 * M2c held-item helpers shared by the third-person views and the viewmodel. Owner: graphics-engineer.
 */
import { SCOPE_FOR_SIGHT, WEAPON_SIGHT_TYPES } from './procedural';

export type DrawnScope = (typeof SCOPE_FOR_SIGHT)[keyof typeof SCOPE_FOR_SIGHT];

/**
 * The scope model to draw on a held gun from its effective sight (PlayerState.sight / ViewmodelView.sight): null when
 * that is the gun's built-in sight, iron or none (or the item is not a gun). Pure.
 */
export function heldScope(w: string, sight: string | null | undefined): DrawnScope | null {
  if (!sight || sight === 'none' || sight === 'iron') return null;
  const builtIn = WEAPON_SIGHT_TYPES[w];
  if (!builtIn || sight === builtIn) return null;
  return (SCOPE_FOR_SIGHT as Record<string, DrawnScope>)[sight] ?? null;
}
