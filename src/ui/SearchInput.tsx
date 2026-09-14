import { useEffect, useState, type ChangeEventHandler } from 'react';

// Supported queries from scripts/fixtures/search-evaluation.json, plus the original hint.
// The top-performance case is omitted because the selected model failed that evaluation.
const examples = [
  'команды с эффективностью ниже 80%',
  'Выбери три отдела с самым большим бюджетом',
  'Команды, где работает максимум 8 сотрудников',
  'Отделы по убыванию бюджета',
  'Все подразделения по алфавиту',
  'Мне нужен список команд',
  'Отобрази все отделы компании',
  'Хочу посмотреть дивизионы',
  'Название подразделения содержит «аналитика»',
  'Нужны отделы со словом «поддержка» в названии',
  'Найди команды, в которых работает больше 17 человек',
  'Оставь подразделения, где сотрудников хотя бы 25',
  'Покажи отделы, у которых численность меньше 14 человек',
  'Ищу подразделения с ровно 12 сотрудниками',
  'В каких отделах совсем нет сотрудников?',
  'Нужны команды с бюджетом свыше 740 тысяч рублей',
  'Дивизионы, чей бюджет составляет не менее 2,75 миллиона рублей',
  'Отделы, у которых бюджет меньше 625,5 тыс. руб.',
  'Подразделения с бюджетом не больше 9 млн рублей',
  'Найти команды: бюджет равен 1 250 000 рублей',
  'Где эффективность превышает 91 процент?',
  'Отделы, эффективность которых не ниже 72%',
  'Хочу увидеть команды с результативностью ниже 67,5 процента',
  'Найди дивизионы с эффективностью не выше 88%',
  'Эффективность подразделения должна быть ровно 95%',
  'Отделы с численностью не меньше 30 человек и эффективностью выше 85%',
  'Покажи команды, где меньше 16 сотрудников, бюджет не выше 3,2 млн и эффективность не ниже 79%',
  'Отделы с численностью меньше 6 или бюджетом больше 4 млн',
  'Нужны команды с бюджетом от 700 тысяч до 2 млн рублей',
  'Покажи команды с бюджетом ниже 6 млн, кроме маркетинга',
  'Команды, у которых численность не равна 11',
  'Пять подразделений с самой маленькой численностью',
  'Команды с бюджетом от 480 тысяч до 1,25 миллиона рублей включительно',
  'Отделы с численностью не меньше 18 и не больше 24 сотрудников',
  'Дивизионы с эффективностью ниже 61% или команды с бюджетом не больше 2,4 млн рублей',
  'Подразделения, название которых не содержит «операции», с эффективностью выше 82%',
  'Все подразделения, кроме дивизионов, отсортируй по возрастанию численности',
  'Расположи подразделения по уровню от команд к дивизионам',
];
const characterDelay = 15;

export function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) {
  const [example, setExample] = useState(examples[0]);
  const empty = value.length === 0;

  // Keep animation updates inside the input, without rendering the analytics table on each tick.
  useEffect(() => {
    if (!empty) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rotationTimer: ReturnType<typeof setInterval> | undefined;
    let animationTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearInterval(rotationTimer);
      clearTimeout(animationTimer);
      animationTimer = undefined;
    };
    const start = () => {
      stop();
      let index = 0;
      setExample(examples[index]);
      if (motion.matches) return;
      rotationTimer = setInterval(() => {
        // Background tabs can throttle timers; never overlap two transitions.
        if (animationTimer !== undefined) return;
        const previous = examples[index];
        index = (index + 1) % examples.length;
        const next = examples[index];
        let length = previous.length;
        const erase = () => {
          setExample(previous.slice(0, --length));
          animationTimer = setTimeout(length ? erase : type, characterDelay);
        };
        const type = () => {
          setExample(next.slice(0, ++length));
          animationTimer = length < next.length ? setTimeout(type, characterDelay) : undefined;
        };
        animationTimer = setTimeout(erase, characterDelay);
      }, 4_000);
    };
    start();
    motion.addEventListener('change', start);
    return () => {
      stop();
      motion.removeEventListener('change', start);
    };
  }, [empty]);

  return (
    <input
      aria-label="Поиск подразделения"
      placeholder={`Название или, например: ${example}`}
      maxLength={500}
      value={value}
      onChange={onChange}
    />
  );
}
