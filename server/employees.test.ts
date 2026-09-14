import { describe, expect, it } from 'vitest';
import { MAX_DEMO_EMPLOYEES, resizeDemoEmployees } from './employees.js';

describe('demo employees', () => {
  it('generates a deterministic roster with distinct stable IDs and suitable roles', () => {
    const frontend = resizeDemoEmployees('frontend', 4);
    expect(frontend).toEqual(resizeDemoEmployees('frontend', 4));
    expect(new Set(frontend.map((employee) => employee.id)).size).toBe(4);
    expect(frontend.every((employee) => /^[А-ЯЁа-яё]+ [А-ЯЁа-яё]+$/.test(employee.name))).toBe(
      true,
    );
    expect(frontend[0]!.role).toBe('Фронтенд-разработчик');
    expect(resizeDemoEmployees('accounting', 1)[0]!.role).toBe('Бухгалтер');
    expect(resizeDemoEmployees('backend', 1)[0]!.id).not.toBe(frontend[0]!.id);
  });

  it('keeps surviving employees unchanged while growing, shrinking, and restoring an empty unit', () => {
    const initial = resizeDemoEmployees('frontend', 2);
    const grown = resizeDemoEmployees('frontend', 4, initial);
    expect(grown.slice(0, 2)).toEqual(initial);
    expect(grown[0]).not.toBe(initial[0]);
    expect(resizeDemoEmployees('frontend', 1, grown)).toEqual(initial.slice(0, 1));
    expect(resizeDemoEmployees('frontend', 0, grown)).toEqual([]);
    expect(resizeDemoEmployees('frontend', 4, [])).toEqual(grown);
  });

  it.each([-1, 1.5, Infinity, NaN, MAX_DEMO_EMPLOYEES + 1, Number.MAX_SAFE_INTEGER])(
    'rejects unsupported sizes before allocating a roster: %s',
    (count) => expect(() => resizeDemoEmployees('frontend', count)).toThrow('Demo headcount'),
  );
});
