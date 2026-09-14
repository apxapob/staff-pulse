const integer = new Intl.NumberFormat('ru-RU');
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
export const formatNumber = (value: number) => integer.format(value);
export const formatBudget = (value: number) => `${integer.format(value)} руб.`;
export const formatPerformance = (value: number | null) =>
  value === null ? '—' : `${decimal.format(value)}%`;
export const performanceTone = (value: number | null) =>
  value === null || value < 65
    ? ('low' as const)
    : value < 80
      ? ('medium' as const)
      : ('good' as const);
