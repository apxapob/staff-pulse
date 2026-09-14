import type { OrgEmployee } from './types';

/** Roster order is visible in the UI; absent and explicitly empty are distinct. */
export function employeeRostersEqual(
  first: readonly OrgEmployee[] | undefined,
  second: readonly OrgEmployee[] | undefined,
): boolean {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.length === second.length &&
      first.every((employee, position) => {
        const other = second[position];
        return (
          employee.id === other?.id && employee.name === other.name && employee.role === other.role
        );
      }))
  );
}
