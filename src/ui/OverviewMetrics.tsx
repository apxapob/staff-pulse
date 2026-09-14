import { Building2, Users, Wallet, Zap } from 'lucide-react';
import styled from 'styled-components';
import type { OrgAggregate, OrgIndex } from '@/domain/types';
import { formatNumber, formatPerformance } from '@/ui/format';

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  margin-bottom: 28px;
  @media (max-width: 1100px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  @media (max-width: 480px) {
    gap: 10px;
  }
`;
const Card = styled.section`
  background: #fff;
  border: 1px solid #e8eaf1;
  border-radius: 12px;
  padding: 20px 21px 17px;
  min-width: 0;
  h2 {
    color: #898ea1;
    font-size: 11px;
    font-weight: 500;
    margin: 0;
  }
  strong {
    display: block;
    margin: 16px 0 12px;
    font-size: 29px;
    font-weight: 650;
    letter-spacing: -0.7px;
    color: #32364e;
    font-variant-numeric: tabular-nums;
  }
  small {
    font-size: 10px;
    color: #9da1b2;
  }
  @media (max-width: 480px) {
    padding: 16px 13px;
    strong {
      font-size: 25px;
    }
  }
`;
const CardHead = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
`;
const CardIcon = styled.div<{ $color: string; $background: string }>`
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  border-radius: 8px;
  color: ${({ $color }) => $color};
  background: ${({ $background }) => $background};
`;
const Accent = styled.span`
  color: #53a58b;
`;

export function OverviewMetrics({
  index,
  aggregates,
}: {
  index: OrgIndex;
  aggregates: ReadonlyMap<string, OrgAggregate>;
}) {
  const totals = index.rootIds.reduce(
    (total, id) => {
      const aggregate = aggregates.get(id)!;
      return {
        headcount: total.headcount + aggregate.headcount,
        budget: total.budget + aggregate.budget,
        weight: total.weight + (aggregate.performance ?? 0) * aggregate.headcount,
      };
    },
    { headcount: 0, budget: 0, weight: 0 },
  );
  const teams = [...index.depthById.values()].filter((depth) => depth === 3).length;
  return (
    <Grid aria-label="Общие показатели">
      <Card>
        <CardHead>
          <h2>Всего сотрудников</h2>
          <CardIcon $color="#8174de" $background="#f2effe">
            <Users size={15} />
          </CardIcon>
        </CardHead>
        <strong>{formatNumber(totals.headcount)}</strong>
        <small>
          <Accent>{index.rootIds.length} дивизионов</Accent> · единая команда
        </small>
      </Card>
      <Card>
        <CardHead>
          <h2>Бюджет в месяц</h2>
          <CardIcon $color="#679bcc" $background="#edf5fd">
            <Wallet size={15} />
          </CardIcon>
        </CardHead>
        <strong>
          {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(
            totals.budget / 1_000_000,
          )}{' '}
          млн ₽
        </strong>
        <small>Сумма по всем подразделениям</small>
      </Card>
      <Card>
        <CardHead>
          <h2>Эффективность</h2>
          <CardIcon $color="#d5a14f" $background="#fff7e8">
            <Zap size={15} />
          </CardIcon>
        </CardHead>
        <strong>
          {formatPerformance(totals.headcount ? totals.weight / totals.headcount : null)}
        </strong>
        <small>
          <Accent>Средняя взвешенная</Accent> по сотрудникам
        </small>
      </Card>
      <Card>
        <CardHead>
          <h2>Подразделения</h2>
          <CardIcon $color="#67a590" $background="#edf7f2">
            <Building2 size={15} />
          </CardIcon>
        </CardHead>
        <strong>{index.nodesById.size}</strong>
        <small>
          {teams} команд · {Math.max(...index.depthById.values())} уровня структуры
        </small>
      </Card>
    </Grid>
  );
}
