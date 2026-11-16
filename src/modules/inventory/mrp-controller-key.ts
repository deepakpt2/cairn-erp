/** Pure helpers for the MRP controller key — no server imports, so client components may use them. */

export const ACTIVITY = 'CFG.PROD.MRPCONTROLLER.DEFINE';
export const MRP_CONTROLLER_ROUTE = '/config/mrp-controllers';
export const LOCK_OBJECT = 'MRP_CONTROLLER';

/**
 * The composite key: one object key out of two fields, in a shape that cannot be ambiguous about where
 * one field ends. Used for the change-document key, the enqueue argument and the `?key=` parameter.
 */
export function mrpControllerKey(plant: string, controller: string): string {
  const p = plant.trim();
  const c = controller.trim().toUpperCase();
  return `${p.length}:${p}${c.length}:${c}`;
}

/** Inverse of {@link mrpControllerKey}; null when the text is not a well-formed composite. */
export function parseMrpControllerKey(key: string): { plant: string; controller: string } | null {
  const first = /^(\d+):/.exec(key ?? '');
  if (!first) return null;
  const plantLength = Number(first[1]);
  const plantStart = first[0].length;
  const plant = key.slice(plantStart, plantStart + plantLength);
  const rest = key.slice(plantStart + plantLength);
  const second = /^(\d+):/.exec(rest);
  if (!second || plant.length !== plantLength) return null;
  const controllerLength = Number(second[1]);
  const controller = rest.slice(second[0].length);
  if (controller.length !== controllerLength || !plant || !controller) return null;
  return { plant, controller };
}
