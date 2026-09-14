export interface OrgNode {
  id: string;
  name: string;
  parentId: string | null;
  headcount: number;
  budget: number;
  performance: number;
  updatedAt: string;
}

interface TeamSeed {
  id: string;
  name: string;
  headcount: number;
  budget: number;
  performance: number;
}

interface DepartmentSeed extends TeamSeed {
  teams: TeamSeed[];
}

interface DivisionSeed extends TeamSeed {
  departments: DepartmentSeed[];
}

const INITIAL_UPDATED_AT = '2026-09-14T09:00:00.000Z';

// Every metric belongs only to this unit (managers for divisions/departments).
// Clients aggregate descendants. Budgets are monthly and denominated in roubles.
const divisions: DivisionSeed[] = [
  {
    id: 'technology',
    name: 'Технологии',
    headcount: 4,
    budget: 1_800_000,
    performance: 92,
    departments: [
      {
        id: 'development',
        name: 'Разработка',
        headcount: 3,
        budget: 1_200_000,
        performance: 91,
        teams: [
          {
            id: 'frontend',
            name: 'Веб-платформа',
            headcount: 12,
            budget: 3_840_000,
            performance: 93,
          },
          {
            id: 'backend',
            name: 'Серверная разработка',
            headcount: 16,
            budget: 5_600_000,
            performance: 89,
          },
          {
            id: 'mobile',
            name: 'Мобильные приложения',
            headcount: 9,
            budget: 2_970_000,
            performance: 86,
          },
        ],
      },
      {
        id: 'infrastructure',
        name: 'Инфраструктура',
        headcount: 2,
        budget: 840_000,
        performance: 94,
        teams: [
          {
            id: 'devops',
            name: 'Облачная инфраструктура',
            headcount: 7,
            budget: 3_080_000,
            performance: 95,
          },
          {
            id: 'security',
            name: 'Информационная безопасность',
            headcount: 5,
            budget: 1_750_000,
            performance: 91,
          },
        ],
      },
      {
        id: 'quality',
        name: 'Обеспечение качества',
        headcount: 2,
        budget: 640_000,
        performance: 87,
        teams: [
          {
            id: 'qa-automation',
            name: 'Автоматизация тестирования',
            headcount: 8,
            budget: 2_160_000,
            performance: 88,
          },
          {
            id: 'qa-product',
            name: 'Продуктовое тестирование',
            headcount: 6,
            budget: 1_380_000,
            performance: 78,
          },
        ],
      },
    ],
  },
  {
    id: 'product',
    name: 'Продукт и дизайн',
    headcount: 3,
    budget: 1_290_000,
    performance: 89,
    departments: [
      {
        id: 'product-management',
        name: 'Управление продуктами',
        headcount: 2,
        budget: 740_000,
        performance: 86,
        teams: [
          {
            id: 'product-core',
            name: 'Основной продукт',
            headcount: 6,
            budget: 1_860_000,
            performance: 90,
          },
          {
            id: 'product-growth',
            name: 'Развитие продукта',
            headcount: 5,
            budget: 1_500_000,
            performance: 72,
          },
        ],
      },
      {
        id: 'design',
        name: 'Дизайн',
        headcount: 1,
        budget: 340_000,
        performance: 91,
        teams: [
          {
            id: 'ux',
            name: 'Пользовательский опыт',
            headcount: 5,
            budget: 1_300_000,
            performance: 92,
          },
          {
            id: 'brand-design',
            name: 'Бренд и коммуникации',
            headcount: 4,
            budget: 920_000,
            performance: 85,
          },
        ],
      },
      {
        id: 'analytics',
        name: 'Аналитика',
        headcount: 2,
        budget: 760_000,
        performance: 93,
        teams: [
          {
            id: 'product-analytics',
            name: 'Продуктовая аналитика',
            headcount: 7,
            budget: 2_170_000,
            performance: 94,
          },
          {
            id: 'research',
            name: 'Исследования пользователей',
            headcount: 4,
            budget: 1_000_000,
            performance: 81,
          },
        ],
      },
    ],
  },
  {
    id: 'commercial',
    name: 'Коммерческий блок',
    headcount: 5,
    budget: 2_100_000,
    performance: 88,
    departments: [
      {
        id: 'sales',
        name: 'Продажи',
        headcount: 3,
        budget: 1_080_000,
        performance: 90,
        teams: [
          {
            id: 'enterprise-sales',
            name: 'Корпоративные клиенты',
            headcount: 11,
            budget: 3_300_000,
            performance: 96,
          },
          {
            id: 'smb-sales',
            name: 'Малый и средний бизнес',
            headcount: 14,
            budget: 3_080_000,
            performance: 82,
          },
        ],
      },
      {
        id: 'marketing',
        name: 'Маркетинг',
        headcount: 2,
        budget: 680_000,
        performance: 81,
        teams: [
          {
            id: 'performance-marketing',
            name: 'Привлечение клиентов',
            headcount: 6,
            budget: 3_600_000,
            performance: 76,
          },
          {
            id: 'content',
            name: 'Контент и редакция',
            headcount: 5,
            budget: 1_100_000,
            performance: 87,
          },
        ],
      },
      {
        id: 'partnerships',
        name: 'Партнёрства',
        headcount: 1,
        budget: 350_000,
        performance: 84,
        teams: [
          {
            id: 'partner-network',
            name: 'Партнёрская сеть',
            headcount: 5,
            budget: 1_250_000,
            performance: 84,
          },
          {
            id: 'integrations',
            name: 'Интеграции и альянсы',
            headcount: 4,
            budget: 1_200_000,
            performance: 69,
          },
        ],
      },
    ],
  },
  {
    id: 'customer-service',
    name: 'Клиентский сервис',
    headcount: 3,
    budget: 1_050_000,
    performance: 91,
    departments: [
      {
        id: 'support',
        name: 'Поддержка',
        headcount: 3,
        budget: 810_000,
        performance: 90,
        teams: [
          {
            id: 'support-first-line',
            name: 'Первая линия',
            headcount: 18,
            budget: 2_520_000,
            performance: 91,
          },
          {
            id: 'support-technical',
            name: 'Техническая поддержка',
            headcount: 10,
            budget: 2_100_000,
            performance: 88,
          },
        ],
      },
      {
        id: 'customer-success',
        name: 'Развитие клиентов',
        headcount: 2,
        budget: 600_000,
        performance: 89,
        teams: [
          {
            id: 'onboarding',
            name: 'Внедрение и обучение',
            headcount: 8,
            budget: 1_680_000,
            performance: 83,
          },
          {
            id: 'account-management',
            name: 'Сопровождение клиентов',
            headcount: 9,
            budget: 2_160_000,
            performance: 93,
          },
        ],
      },
    ],
  },
  {
    id: 'finance',
    name: 'Финансы и операции',
    headcount: 2,
    budget: 840_000,
    performance: 94,
    departments: [
      {
        id: 'financial-control',
        name: 'Финансовое управление',
        headcount: 2,
        budget: 680_000,
        performance: 95,
        teams: [
          {
            id: 'accounting',
            name: 'Бухгалтерия',
            headcount: 6,
            budget: 1_200_000,
            performance: 97,
          },
          {
            id: 'planning',
            name: 'Планирование и контроль',
            headcount: 4,
            budget: 1_080_000,
            performance: 89,
          },
        ],
      },
      {
        id: 'operations',
        name: 'Операционная деятельность',
        headcount: 1,
        budget: 300_000,
        performance: 88,
        teams: [
          { id: 'procurement', name: 'Закупки', headcount: 4, budget: 1_600_000, performance: 79 },
          {
            id: 'legal',
            name: 'Юридическая служба',
            headcount: 3,
            budget: 810_000,
            performance: 92,
          },
        ],
      },
    ],
  },
  {
    id: 'people',
    name: 'Команда и культура',
    headcount: 2,
    budget: 740_000,
    performance: 89,
    departments: [
      {
        id: 'talent',
        name: 'Привлечение талантов',
        headcount: 1,
        budget: 310_000,
        performance: 83,
        teams: [
          {
            id: 'recruiting',
            name: 'Подбор персонала',
            headcount: 5,
            budget: 1_250_000,
            performance: 74,
          },
          {
            id: 'employer-brand',
            name: 'Бренд работодателя',
            headcount: 3,
            budget: 720_000,
            performance: 86,
          },
        ],
      },
      {
        id: 'people-development',
        name: 'Развитие команды',
        headcount: 1,
        budget: 300_000,
        performance: 92,
        teams: [
          {
            id: 'learning',
            name: 'Обучение и развитие',
            headcount: 4,
            budget: 960_000,
            performance: 88,
          },
          {
            id: 'people-operations',
            name: 'Кадровые операции',
            headcount: 4,
            budget: 800_000,
            performance: 95,
          },
        ],
      },
    ],
  },
];

function createSeed(): OrgNode[] {
  const nodes: OrgNode[] = [];

  for (const division of divisions) {
    const { departments, ...divisionMetrics } = division;
    nodes.push({ ...divisionMetrics, parentId: null, updatedAt: INITIAL_UPDATED_AT });

    for (const department of departments) {
      const { teams, ...departmentMetrics } = department;
      nodes.push({ ...departmentMetrics, parentId: division.id, updatedAt: INITIAL_UPDATED_AT });
      nodes.push(
        ...teams.map((team) => ({
          ...team,
          parentId: department.id,
          updatedAt: INITIAL_UPDATED_AT,
        })),
      );
    }
  }

  return nodes;
}

export const orgTreeSeed: readonly Readonly<OrgNode>[] = Object.freeze(
  createSeed().map((node) => Object.freeze(node)),
);

/** Each server receives an isolated mutable copy, including in tests. */
export function getFreshOrgTree(): OrgNode[] {
  return orgTreeSeed.map((node) => ({ ...node }));
}
