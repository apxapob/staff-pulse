import { useState } from 'react';
import { LayoutDashboard, Network, Orbit, TriangleAlert, Users } from 'lucide-react';
import styled from 'styled-components';
import { useOrgTree } from '@/data/query';
import { useLiveUpdates } from '@/data/live';
import { Analytics } from '@/ui/Analytics';
import { OverviewMetrics } from '@/ui/OverviewMetrics';
import { OrgTree } from '@/ui/OrgTree';
import { Button, Dot, Panel, Skeleton, State } from '@/ui/styles';

const Layout = styled.div`
  min-height: 100vh;
`;
const Content = styled.div`
  min-width: 0;
`;
const Topbar = styled.header`
  height: 74px;
  border-bottom: 1px solid #e9ebf2;
  background: #fff;
  padding: 0 34px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #a0a4b4;
  gap: 12px;
  @media (max-width: 600px) {
    padding: 14px 16px;
    height: auto;
    flex-wrap: wrap;
  }
`;
const CompanyBrand = styled.div`
  display: flex;
  align-items: center;
  gap: 11px;
  color: #30334e;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.3px;
  white-space: nowrap;
`;
const CompanyLogo = styled.span`
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 10px;
  background: #625be7;
  color: #fff;
`;
const Connection = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: #7d8398;
  @media (max-width: 600px) {
    width: 100%;
  }
`;
const Main = styled.main`
  padding: 33px 34px 22px;
  max-width: 1700px;
  margin: auto;
  @media (max-width: 600px) {
    padding: 24px 16px;
  }
`;
const Intro = styled.h1`
  margin: 0 0 29px;
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.8px;
  @media (max-width: 600px) {
    font-size: 25px;
  }
`;
const Dashboard = styled.div<{ $view: 'tree' | 'table' }>`
  display: grid;
  grid-template-columns: 310px minmax(0, 1fr);
  gap: 20px;
  > section {
    display: flex;
    flex-direction: column;
    height: 740px;
    > * {
      flex-shrink: 0;
    }
  }
  @media (max-width: 1279px) {
    grid-template-columns: 1fr;
    > section:first-child {
      display: ${({ $view }) => ($view === 'tree' ? 'flex' : 'none')};
    }
    > section:last-child {
      display: ${({ $view }) => ($view === 'table' ? 'flex' : 'none')};
    }
  }
`;
const ViewTabs = styled.div`
  display: none;
  margin-bottom: 16px;
  gap: 8px;
  @media (max-width: 1279px) {
    display: flex;
  }
`;
const SectionTitle = styled.h2`
  margin: 29px 0 16px;
  font-size: 15px;
  font-weight: 600;
`;
const Notice = styled.div`
  background: #fff7e7;
  border: 1px solid #f0ddb5;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 20px;
  color: #987a3b;
  font-size: 12px;
`;

export function App() {
  const query = useOrgTree();
  const index = query.data?.index;
  const aggregates = query.data?.aggregates;
  const connection = useLiveUpdates(Boolean(query.data?.cursor));
  const connectionLabel = {
    connecting: 'Подключение...',
    live: 'Обновляется в реальном времени',
    reconnecting: 'Восстанавливаем соединение',
    offline: 'Нет соединения',
  }[connection];
  const [view, setView] = useState<'tree' | 'table'>('table');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealVersion, setRevealVersion] = useState(0);
  const selectFromTable = (id: string) => {
    setSelectedId(id);
    setRevealVersion((version) => version + 1);
  };
  return (
    <Layout>
      <Content>
        <Topbar>
          <CompanyBrand>
            <CompanyLogo aria-hidden="true">
              <Orbit size={23} strokeWidth={1.8} />
            </CompanyLogo>
            Орбита Групп
          </CompanyBrand>
          <Connection aria-label="Статус соединения" role="status" aria-live="polite">
            <Dot
              $tone={connection === 'live' ? 'good' : connection === 'offline' ? 'low' : 'medium'}
            />
            {connectionLabel}
          </Connection>
        </Topbar>
        <Main id="overview">
          <Intro>Обзор компании</Intro>
          {query.isError && query.data && (
            <Notice role="alert">
              Не удалось обновить данные. Показана последняя загруженная версия.{' '}
              {query.error.message}
            </Notice>
          )}
          {query.isPending ? (
            <Panel aria-label="Загрузка данных" role="status">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} />
              ))}
            </Panel>
          ) : query.isError && !query.data ? (
            <Panel>
              <State role="alert">
                <TriangleAlert size={32} />
                <h2>Не удалось загрузить структуру</h2>
                <p>{query.error.message}</p>
                <Button $primary onClick={() => void query.refetch()}>
                  Попробовать ещё раз
                </Button>
              </State>
            </Panel>
          ) : !index?.nodesById.size ? (
            <Panel>
              <State>
                <Users size={34} />
                <h2>Пока нет подразделений</h2>
                <p>Когда в компании появятся команды, здесь будет их структура и аналитика.</p>
                <Button onClick={() => void query.refetch()}>Обновить</Button>
              </State>
            </Panel>
          ) : (
            <>
              <OverviewMetrics index={index} aggregates={aggregates!} />
              <SectionTitle>Организационная структура</SectionTitle>
              <ViewTabs role="group" aria-label="Вид данных">
                <Button
                  $primary={view === 'tree'}
                  aria-pressed={view === 'tree'}
                  onClick={() => setView('tree')}
                >
                  <Network size={14} />
                  Дерево
                </Button>
                <Button
                  $primary={view === 'table'}
                  aria-pressed={view === 'table'}
                  onClick={() => setView('table')}
                >
                  <LayoutDashboard size={14} />
                  Таблица
                </Button>
              </ViewTabs>
              <Dashboard $view={view}>
                <OrgTree
                  index={index}
                  aggregates={aggregates!}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  revealVersion={revealVersion}
                />
                <Analytics
                  index={index}
                  aggregates={aggregates!}
                  selectedId={selectedId}
                  onSelect={selectFromTable}
                  changedFields={query.data!.changedFields}
                  changeVersion={query.data!.cursor}
                />
              </Dashboard>
            </>
          )}
        </Main>
      </Content>
    </Layout>
  );
}
