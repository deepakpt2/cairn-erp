/**
 * Which valuation class a material type may carry.
 *
 * The account category reference is derived from the material type. The
 * class must be active and assigned to that reference. A non-empty type
 * list on the class narrows further, so a delivered raw class stays with
 * raw materials while those types share one reference. An empty list
 * permits every type on the assigned reference. There is no unrestricted
 * fallback.
 */

export function namedMaterialTypes(allowedMaterialTypes: string): string[] {
  return allowedMaterialTypes
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function classPermittedForType(input: {
  materialType: string;
  reference: string | null | undefined;
  referenceActive: boolean;
  classActive: boolean;
  allowedMaterialTypes: string;
  assignedToReference: boolean;
}): boolean {
  if (!input.classActive || !input.referenceActive || !input.reference) return false;
  if (!input.assignedToReference) return false;
  const named = namedMaterialTypes(input.allowedMaterialTypes);
  return named.length === 0 || named.includes(input.materialType);
}
