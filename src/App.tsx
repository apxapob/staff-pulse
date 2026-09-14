import { useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Building2,
  CircleHelp,
  LayoutDashboard,
  Network,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import styled from 'styled-components';
import { useOrgTree } from '@/data/query';
import { useLiveUpdates } from '@/data/live';
import { Analytics } from '@/ui/Analytics';
import { OverviewMetrics } from '@/ui/OverviewMetrics';
import { OrgTree } from '@/ui/OrgTree';
import { Button, Dot, Panel, Skeleton, State } from '@/ui/styles';

const Layout = styled.div`
  min-height: 100vh;
  display: grid;
  grid-template-columns: 218px minmax(0, 1fr);
  @media (max-width: 1050px) {
    grid-template-columns: 76px minmax(0, 1fr);
  }
  @media (max-width: 600px) {
    display: block;
  }
`;
const Sidebar = styled.aside`
  background: #fff;
  border-right: 1px solid #e9ebf2;
  display: flex;
  flex-direction: column;
  padding: 30px 18px 20px;
  position: sticky;
  top: 0;
  height: 100vh;
  @media (max-width: 1050px) {
    padding: 24px 12px;
  }
  @media (max-width: 600px) {
    display: none;
  }
`;
const Brand = styled.a`
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  font-size: 20px;
  font-weight: 750;
  letter-spacing: -0.8px;
  padding: 0 8px;
  color: #30334e;
  white-space: nowrap;
  span {
    color: #76798c;
    font-weight: 400;
  }
  @media (max-width: 1050px) {
    padding: 0;
    b {
      display: none;
    }
  }
`;
const Logo = styled.div`
  height: 34px;
  width: 34px;
  background: #625be7;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: white;
  flex-shrink: 0;
`;
const Workspace = styled.div`
  border: 1px solid #e9ebf1;
  border-radius: 9px;
  padding: 12px 9px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin: 35px 0 29px;
  strong {
    display: block;
    font-size: 11px;
    margin-bottom: 4px;
  }
  small {
    color: #9b9eae;
    font-size: 10px;
  }
  > svg {
    color: #8c8fba;
  }
  @media (max-width: 1050px) {
    justify-content: center;
    border: 0;
    padding: 4px;
    div {
      display: none;
    }
  }
`;
const NavLabel = styled.p`
  font-size: 9px;
  letter-spacing: 1.4px;
  color: #afb2c0;
  padding-left: 12px;
  margin: 0 0 12px;
  @media (max-width: 1050px) {
    display: none;
  }
`;
const NavItem = styled.a`
  display: flex;
  gap: 11px;
  align-items: center;
  border-radius: 8px;
  padding: 12px;
  color: #655ce0;
  background: #f0eeff;
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  @media (max-width: 1050px) {
    span {
      display: none;
    }
  }
`;
const SidebarInfo = styled.div`
  padding: 22px 12px;
  color: #a0a4b5;
  font-size: 11px;
  line-height: 1.7;
  display: flex;
  gap: 11px;
  svg {
    margin-top: 2px;
  }
  @media (max-width: 1050px) {
    span {
      display: none;
    }
  }
`;
const Profile = styled.div`
  margin-top: auto;
  border-top: 1px solid #eef0f4;
  padding: 20px 7px 0;
  display: flex;
  gap: 10px;
  align-items: center;
  strong {
    display: block;
    font-size: 11px;
  }
  small {
    font-size: 10px;
    color: #a3a6b5;
  }
  @media (max-width: 1050px) {
    padding: 18px 0;
    div:last-child {
      display: none;
    }
  }
`;
const Avatar = styled.div`
  background: #eeecff;
  border: 2px solid #fff;
  outline: 1px solid #eeecff;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #7b70c5;
  flex-shrink: 0;
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
  strong {
    color: #5e637b;
    font-weight: 500;
  }
  @media (max-width: 600px) {
    padding: 0 20px;
    height: 60px;
    > span {
      display: none;
    }
  }
`;
const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: 22px;
  @media (max-width: 600px) {
    width: 100%;
    justify-content: space-between;
  }
`;
const Connection = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: #7d8398;
`;
const Main = styled.main`
  padding: 33px 34px 22px;
  max-width: 1700px;
  margin: auto;
  @media (max-width: 600px) {
    padding: 24px 16px;
  }
`;
const Intro = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 29px;
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 650;
    letter-spacing: -0.8px;
  }
  p {
    color: #8b90a3;
    font-size: 12px;
    line-height: 1.6;
    margin: 9px 0 0;
  }
  @media (max-width: 600px) {
    align-items: flex-start;
    h1 {
      font-size: 25px;
    }
    button {
      font-size: 0;
      gap: 0;
    }
  }
`;
const Dashboard = styled.div<{ $view: 'tree' | 'table' }>`
  display: grid;
  grid-template-columns: 310px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
  @media (max-width: 1279px) {
    grid-template-columns: 1fr;
    > section:first-child {
      display: ${({ $view }) => ($view === 'tree' ? 'block' : 'none')};
    }
    > section:last-child {
      display: ${({ $view }) => ($view === 'table' ? 'block' : 'none')};
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
const SectionTitle = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 29px 0 16px;
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
  }
  span {
    color: #9da2b4;
    font-size: 10px;
  }
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
const Footer = styled.footer`
  padding: 22px 0 0;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 10px;
  color: #a0a5b5;
  span {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  a {
    text-decoration: none;
  }
  @media (max-width: 600px) {
    flex-direction: column;
  }
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
  return (
    <Layout>
      <Sidebar>
        <Brand href="/" aria-label="Staff Pulse, главная">
          <Logo>
            <Activity size={22} />
          </Logo>
          <b>
            staff<span>pulse</span>
          </b>
        </Brand>
        <Workspace>
          <Building2 size={22} />
          <div>
            <strong>Орбита Групп</strong>
            <small>Рабочее пространство</small>
          </div>
        </Workspace>
        <NavLabel>РАБОЧЕЕ ПРОСТРАНСТВО</NavLabel>
        <nav>
          <NavItem href="#overview" aria-current="page">
            <LayoutDashboard size={17} />
            <span>Обзор компании</span>
          </NavItem>
        </nav>
        <SidebarInfo>
          <Network size={16} />
          <span>
            Дивизионы, отделы
            <br />и команды в одном месте
          </span>
        </SidebarInfo>
        <Profile>
          <Avatar>ОГ</Avatar>
          <div>
            <strong>Орбита Групп</strong>
            <small>Демонстрационный режим</small>
          </div>
        </Profile>
      </Sidebar>
      <Content>
        <Topbar>
          <span>
            Рабочее пространство &nbsp; / &nbsp; <strong>Обзор компании</strong>
          </span>
          <HeaderRight>
            <Connection aria-label="Статус соединения" role="status" aria-live="polite">
              <Dot
                $tone={connection === 'live' ? 'good' : connection === 'offline' ? 'low' : 'medium'}
              />
              {connectionLabel}
            </Connection>
            <a
              href="https://github.com/apxapob/staff-pulse#readme"
              aria-label="Справка о приложении"
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp size={17} />
            </a>
            <Avatar>ОГ</Avatar>
          </HeaderRight>
        </Topbar>
        <Main id="overview">
          <Intro>
            <div>
              <h1>Обзор компании</h1>
              <p>Люди, структура и эффективность. Вся картина в одном месте.</p>
            </div>
            <Button onClick={() => void query.refetch()} disabled={query.isFetching}>
              <RefreshCw size={14} />
              Обновить данные
            </Button>
          </Intro>
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
              <SectionTitle>
                <h2>Организационная структура</h2>
                <span>Обзор всех подразделений</span>
              </SectionTitle>
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
                <OrgTree index={index} selectedId={selectedId} onSelect={setSelectedId} />
                <Analytics
                  index={index}
                  aggregates={aggregates!}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  changedFields={query.data!.changedFields}
                  changeVersion={query.data!.cursor}
                />
              </Dashboard>
            </>
          )}
          <Footer>
            <span>
              <ShieldCheck size={13} />
              Демонстрационные данные · бюджеты в рублях
            </span>
            <a href="https://github.com/apxapob/staff-pulse" target="_blank" rel="noreferrer">
              Staff Pulse · Исходный код <ArrowUpRight size={12} />
            </a>
          </Footer>
        </Main>
      </Content>
    </Layout>
  );
}
