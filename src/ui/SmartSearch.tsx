import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, Sparkles, X } from 'lucide-react';
import styled, { keyframes } from 'styled-components';
import {
  emptySearchFilter,
  parseSearchFilter,
  type SearchCondition,
  type SearchResult,
} from '@/search/filter';
import { parseSearchStatus, type SearchStatus } from '@/search/status';
import { formatBudget, formatNumber } from '@/ui/format';

const spin = keyframes`to { transform: rotate(360deg); }`;
const Tooltip = styled.span`
  position: absolute;
  z-index: 3;
  top: calc(100% + 7px);
  right: 0;
  width: 260px;
  padding: 9px 11px;
  border-radius: 7px;
  background: #38324e;
  color: #fff;
  font-size: 11px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
  box-shadow: 0 3px 12px #29213826;
  visibility: hidden;
  pointer-events: none;
  @media (max-width: 600px) {
    width: 100%;
  }
`;
const ActionWrapper = styled.span<{ $dismissed: boolean }>`
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-self: stretch;
  min-height: 37px;
  border-radius: 7px;
  &:focus-visible {
    outline: 2px solid #aaa4eb;
    outline-offset: 2px;
  }
  &:hover ${Tooltip}, &:focus-within ${Tooltip} {
    visibility: ${({ $dismissed }) => ($dismissed ? 'hidden' : 'visible')};
  }
`;
const SearchAction = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid #ded9fa;
  background: #f5f2ff;
  color: #8070ca;
  border-radius: 7px;
  padding: 8px 11px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  &:hover {
    background: #ece7ff;
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
    pointer-events: none;
  }
  svg[data-loading] {
    animation: ${spin} 1s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    svg[data-loading] {
      animation: none;
    }
  }
`;
const Result = styled.div`
  padding: 10px 20px;
  background: #f9f7ff;
  border-bottom: 1px solid #eee9fa;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  font-size: 10px;
  line-height: 1.6;
  color: #9286b2;
  strong {
    color: #8271ae;
    font-weight: 600;
  }
  button {
    border: 0;
    background: transparent;
    color: #a095b7;
    padding: 2px;
  }
`;

const phaseHints: Record<SearchStatus['status'] | 'checking', string> = {
  checking: 'Проверяем готовность умного поиска…',
  preparing: 'Подготавливаем локальную модель. Поиск по названию уже работает.',
  downloading: 'Скачиваем локальную модель. Это может занять несколько минут.',
  warming: 'Прогреваем локальную модель. Умный поиск скоро будет доступен.',
  error: 'Не удалось подготовить модель. Повторите команду запуска; поиск по названию доступен.',
  unavailable: 'Умный поиск временно недоступен. Повторяем проверку автоматически.',
  ready: 'Введите запрос обычными словами, например: команды с эффективностью ниже 80%.',
};

function useSearchStatus() {
  return useQuery({
    queryKey: ['search-status'],
    queryFn: async ({ signal }) => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 5_000);
      try {
        const response = await fetch('/api/search/status', {
          signal: AbortSignal.any([signal, timeout.signal]),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Search status unavailable');
        return parseSearchStatus(await response.json());
      } finally {
        clearTimeout(timer);
      }
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) =>
      state.status === 'success' && state.data?.status === 'ready' ? 15_000 : 2_000,
  });
}

export function SmartSearchButton({
  query,
  onApply,
}: {
  query: string;
  onApply: (result: SearchResult) => void;
}) {
  const statusQuery = useSearchStatus();
  const phase = statusQuery.isError ? 'unavailable' : (statusQuery.data?.status ?? 'checking');
  const ready = phase === 'ready';
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [pending, setPending] = useState(false);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const tooltipId = useId();
  const controller = useRef<AbortController | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [query]);
  const run = async () => {
    const submitted = query.trim();
    if (!readyRef.current || !submitted || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: submitted }),
        signal: current.signal,
      });
      if (!response.ok) throw new Error('Search failed');
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object') throw new Error('Invalid response');
      const data = payload as Record<string, unknown>;
      const filter = parseSearchFilter(data.filter);
      if (
        !['ai', 'local', 'text'].includes(String(data.source)) ||
        typeof data.explanation !== 'string'
      )
        throw new Error('Invalid response');
      if (!current.signal.aborted && queryRef.current.trim() === submitted)
        onApply({
          filter,
          source: data.source as SearchResult['source'],
          explanation: data.explanation,
        });
    } catch {
      if (!current.signal.aborted && queryRef.current.trim() === submitted)
        onApply({
          filter: {
            ...emptySearchFilter(),
            groups: [[{ field: 'name', op: 'contains', value: submitted }]],
          },
          source: 'text',
          explanation: 'Умный поиск недоступен. Ищем точное совпадение фразы в названиях.',
        });
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
      }
    }
  };
  const disabled = !ready || pending || !query.trim();
  const busy = pending || ['checking', 'preparing', 'downloading', 'warming'].includes(phase);
  const hint = pending ? 'Обрабатываем поисковый запрос…' : phaseHints[phase];
  return (
    <ActionWrapper
      role="group"
      aria-label="Доступность умного поиска"
      aria-describedby={tooltipId}
      tabIndex={disabled ? 0 : -1}
      $dismissed={tooltipDismissed}
      onFocus={() => setTooltipDismissed(false)}
      onMouseEnter={() => setTooltipDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setTooltipDismissed(true);
      }}
    >
      <SearchAction
        type="submit"
        disabled={disabled}
        aria-busy={busy}
        aria-describedby={tooltipId}
        onClick={() => void run()}
      >
        {busy ? (
          <LoaderCircle size={13} data-loading aria-hidden="true" />
        ) : phase === 'error' || phase === 'unavailable' ? (
          <CircleAlert size={13} aria-hidden="true" />
        ) : (
          <Sparkles size={13} aria-hidden="true" />
        )}
        Умный поиск
      </SearchAction>
      <Tooltip id={tooltipId} role="tooltip">
        {hint}
      </Tooltip>
    </ActionWrapper>
  );
}

export function SmartSearchResult({
  result,
  onClear,
}: {
  result: SearchResult;
  onClear: () => void;
}) {
  const filter = result.filter;
  const symbols = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', ne: '≠' };
  const labels = {
    name: 'Название',
    level: 'Уровень',
    headcount: 'Сотрудники',
    budget: 'Бюджет',
    performance: 'Эффективность',
  };
  const describe = (condition: SearchCondition): string => {
    if (condition.field === 'name')
      return `Название ${condition.op === 'contains' ? 'содержит' : 'не содержит'} «${condition.value}»`;
    if (condition.field === 'level')
      return `${condition.op === 'ne' ? 'Не: ' : ''}${['', 'Дивизионы', 'Отделы', 'Команды'][condition.value]}`;
    const value =
      condition.field === 'budget'
        ? formatBudget(condition.value)
        : `${formatNumber(condition.value)}${condition.field === 'performance' ? '%' : ''}`;
    return `${labels[condition.field]} ${symbols[condition.op]} ${value}`;
  };
  const predicates = filter.groups
    .map((group) => {
      const text = group.map(describe).join(' И ');
      return filter.groups.length > 1 && group.length > 1 ? `(${text})` : text;
    })
    .join(' ИЛИ ');
  const constraints = [
    predicates,
    filter.sort
      ? `Сортировка: ${labels[filter.sort.field]}, ${filter.sort.direction === 'asc' ? 'по возрастанию' : 'по убыванию'}`
      : null,
    filter.limit !== null ? `Первые ${filter.limit}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Result role="status" aria-label="Результат умного поиска">
      <span>
        <strong>
          {result.source === 'ai'
            ? 'AI-фильтр'
            : result.source === 'local'
              ? 'Локальный разбор'
              : 'Текстовый поиск'}
        </strong>{' '}
        · {constraints}
        <br />
        {result.explanation}
      </span>
      <button aria-label="Сбросить умный фильтр" onClick={onClear}>
        <X size={13} />
      </button>
    </Result>
  );
}
