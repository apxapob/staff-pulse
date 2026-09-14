export interface OrgEmployee {
  id: string;
  name: string;
  role: string;
}

// This server generates a small demo directory, not an unbounded personnel database.
export const MAX_DEMO_EMPLOYEES = 1_000;

const maleNames = [
  'Александр',
  'Дмитрий',
  'Максим',
  'Иван',
  'Михаил',
  'Артём',
  'Даниил',
  'Кирилл',
  'Андрей',
  'Сергей',
  'Алексей',
  'Никита',
  'Илья',
  'Матвей',
  'Роман',
  'Егор',
];
const femaleNames = [
  'Анна',
  'Мария',
  'Елена',
  'Ольга',
  'Ирина',
  'Наталья',
  'Екатерина',
  'Дарья',
  'Алина',
  'Софья',
  'Полина',
  'Виктория',
  'Юлия',
  'Татьяна',
  'Ксения',
  'Вера',
];
const surnames = [
  'Соколов',
  'Крылов',
  'Волков',
  'Орлов',
  'Белов',
  'Морозов',
  'Лебедев',
  'Кузнецов',
  'Смирнов',
  'Павлов',
  'Васильев',
  'Фёдоров',
  'Зайцев',
  'Макаров',
  'Новиков',
  'Тихонов',
  'Лазарев',
  'Виноградов',
  'Громов',
  'Королёв',
  'Мельников',
  'Захаров',
  'Данилов',
  'Рябов',
];

const rolesByNode: Record<string, readonly string[]> = {
  technology: ['Технический директор', 'Архитектор решений', 'Менеджер технических программ'],
  development: ['Руководитель разработки', 'Архитектор ПО', 'Менеджер разработки'],
  frontend: ['Фронтенд-разработчик', 'Инженер веб-платформы'],
  backend: ['Бэкенд-разработчик', 'Инженер серверной платформы'],
  mobile: ['Разработчик мобильных приложений', 'Инженер мобильной платформы'],
  infrastructure: ['Руководитель инфраструктуры', 'Архитектор инфраструктуры'],
  devops: ['DevOps-инженер', 'Инженер надёжности'],
  security: ['Инженер информационной безопасности', 'Аналитик безопасности'],
  quality: ['Руководитель качества', 'Координатор тестирования'],
  'qa-automation': ['Инженер автоматизации тестирования', 'Разработчик тестов'],
  'qa-product': ['Тестировщик', 'Инженер качества'],
  product: ['Директор по продукту', 'Менеджер продуктовых программ'],
  'product-management': ['Руководитель продуктового направления', 'Продуктовый стратег'],
  'product-core': ['Менеджер продукта', 'Бизнес-аналитик'],
  'product-growth': ['Менеджер развития продукта', 'Аналитик роста'],
  design: ['Руководитель дизайна'],
  ux: ['UX-дизайнер', 'Продуктовый дизайнер'],
  'brand-design': ['Бренд-дизайнер', 'Графический дизайнер'],
  analytics: ['Руководитель аналитики', 'Архитектор данных'],
  'product-analytics': ['Продуктовый аналитик', 'Аналитик данных'],
  research: ['Исследователь пользователей', 'UX-исследователь'],
  commercial: ['Коммерческий директор', 'Менеджер коммерческих программ'],
  sales: ['Руководитель продаж', 'Координатор продаж'],
  'enterprise-sales': ['Менеджер корпоративных продаж', 'Менеджер ключевых клиентов'],
  'smb-sales': ['Менеджер по продажам', 'Консультант по продукту'],
  marketing: ['Руководитель маркетинга', 'Маркетинговый стратег'],
  'performance-marketing': ['Специалист по рекламе', 'Маркетинговый аналитик'],
  content: ['Редактор', 'Контент-менеджер'],
  partnerships: ['Руководитель партнёрского направления'],
  'partner-network': ['Менеджер по партнёрствам', 'Координатор партнёрской сети'],
  integrations: ['Менеджер интеграций', 'Инженер интеграций'],
  'customer-service': ['Директор клиентского сервиса', 'Менеджер сервисных программ'],
  support: ['Руководитель поддержки', 'Координатор поддержки'],
  'support-first-line': ['Специалист поддержки', 'Консультант поддержки'],
  'support-technical': ['Инженер технической поддержки', 'Специалист технической поддержки'],
  'customer-success': ['Руководитель развития клиентов', 'Координатор клиентских программ'],
  onboarding: ['Специалист по внедрению', 'Тренер по продукту'],
  'account-management': ['Менеджер сопровождения', 'Менеджер по работе с клиентами'],
  finance: ['Финансовый директор', 'Операционный директор'],
  'financial-control': ['Руководитель финансового управления', 'Финансовый контролёр'],
  accounting: ['Бухгалтер', 'Специалист по расчётам'],
  planning: ['Финансовый аналитик', 'Экономист'],
  operations: ['Руководитель операционной деятельности'],
  procurement: ['Специалист по закупкам', 'Менеджер по снабжению'],
  legal: ['Юрист', 'Юрисконсульт'],
  people: ['Директор по персоналу', 'Менеджер кадровых программ'],
  talent: ['Руководитель привлечения талантов'],
  recruiting: ['Рекрутер', 'Специалист по подбору персонала'],
  'employer-brand': ['Менеджер бренда работодателя', 'Специалист по коммуникациям'],
  'people-development': ['Руководитель развития персонала'],
  learning: ['Менеджер по обучению', 'Методист'],
  'people-operations': ['Специалист по кадровому учёту', 'HR-специалист'],
};

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

/** Synthetic names and roles; each node/position has a stable identity across demo ticks. */
export function createDemoEmployee(nodeId: string, index: number): OrgEmployee {
  const seed = hash(`${nodeId}:${index}`);
  const female = seed % 2 === 0;
  const names = female ? femaleNames : maleNames;
  const name = names[Math.floor(seed / 2) % names.length]!;
  const surname = surnames[Math.floor(seed / 32) % surnames.length]!;
  const roles = rolesByNode[nodeId] ?? ['Специалист'];
  return {
    id: `employee:${encodeURIComponent(nodeId)}:${index + 1}`,
    name: `${name} ${surname}${female ? 'а' : ''}`,
    role: roles[index % roles.length]!,
  };
}

export function resizeDemoEmployees(
  nodeId: string,
  headcount: number,
  previous: readonly OrgEmployee[] = [],
): OrgEmployee[] {
  if (!Number.isSafeInteger(headcount) || headcount < 0 || headcount > MAX_DEMO_EMPLOYEES) {
    throw new Error(`Demo headcount must be between 0 and ${MAX_DEMO_EMPLOYEES}: ${nodeId}`);
  }
  return Array.from({ length: headcount }, (_, index) =>
    previous[index] ? { ...previous[index] } : createDemoEmployee(nodeId, index),
  );
}

/** Never expose an internal employee object through a snapshot or constructor input. */
export function copyEmployees(employees: readonly OrgEmployee[]): OrgEmployee[] {
  return employees.map((employee) => ({ ...employee }));
}

export function freezeEmployees(employees: readonly OrgEmployee[]): readonly OrgEmployee[] {
  return Object.freeze(employees.map((employee) => Object.freeze({ ...employee })));
}
